// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { MermaidDiagram, resetMermaidForTests } from "./mermaid-diagram";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  const proto = SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = () => ({ x: 0, y: 0, width: 80, height: 20 });
  proto.getComputedTextLength = () => 80;
});

afterEach(() => {
  cleanup();
  resetMermaidForTests();
});

describe("MermaidDiagram with the real library", () => {
  it("renders a flowchart to an svg", async () => {
    render(<MermaidDiagram source={"graph TD;\n  A-->B;\n"} />);
    const img = await screen.findByRole("img", { name: "Mermaid diagram" }, { timeout: 20000 });
    expect(img.querySelector("svg")).not.toBeNull();
    expect(img.textContent).toContain("A");
  }, 30000);

  it("shows the source and an alert for a syntax error", async () => {
    render(<MermaidDiagram source={"graph TD\n  A --> -->"} />);
    const alert = await screen.findByRole("alert", undefined, { timeout: 20000 });
    expect(alert.textContent?.length).toBeGreaterThan(0);
    expect(document.querySelector("pre code")?.textContent).toContain("A --> -->");
    expect(document.querySelector("svg")).toBeNull();
  }, 30000);

  it("re-renders a valid diagram after a theme switch and keeps the fallback for an invalid one", async () => {
    const view = render(
      <>
        <MermaidDiagram source={"graph TD;\n  A-->B;\n"} theme="light" />
        <MermaidDiagram source={"graph TD\n  A --> -->"} theme="light" />
      </>,
    );
    const first = await screen.findByRole("img", { name: "Mermaid diagram" }, { timeout: 20000 });
    const lightSvg = first.innerHTML;
    await screen.findByRole("alert", undefined, { timeout: 20000 });
    view.rerender(
      <>
        <MermaidDiagram source={"graph TD;\n  A-->B;\n"} theme="dark" />
        <MermaidDiagram source={"graph TD\n  A --> -->"} theme="dark" />
      </>,
    );
    await waitFor(
      () =>
        expect(screen.getByRole("img", { name: "Mermaid diagram" }).innerHTML).not.toBe(lightSvg),
      { timeout: 20000 },
    );
    expect(screen.getByRole("img").querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("alert").textContent?.length).toBeGreaterThan(0);
  }, 40000);

  it("does not let label HTML become live markup (strict level)", async () => {
    const source =
      'graph TD\n  A["<b onclick=alert(1)>bold</b>"] --> B["<script>alert(2)</script>"]';
    render(<MermaidDiagram source={source} />);
    const img = await screen.findByRole("img", { name: "Mermaid diagram" }, { timeout: 20000 });
    expect(img.innerHTML).not.toMatch(/<script|onclick=/i);
    expect(img.querySelector("script, [onclick]")).toBeNull();
  }, 30000);
});

describe("MermaidDiagram output is free of resource loaders", () => {
  const hostile =
    'graph TD\n  A["<img src=\'https://example.invalid/x.png\'>hello"] --> B["<b>bold</b>"]';

  it("contains no img, image, foreignObject or external url", async () => {
    render(<MermaidDiagram source={hostile} />);
    const el = await screen.findByRole("img", { name: "Mermaid diagram" }, { timeout: 20000 });
    expect(el.querySelector("img, image, foreignObject, iframe, script")).toBeNull();
    expect(el.innerHTML).not.toMatch(/<img/i);
    expect(el.querySelector("svg")).not.toBeNull();
  }, 30000);

  it.each([
    ["flowchart", "graph TD;\n  Start-->Stop;\n", ["Start", "Stop"], "rect, path"],
    [
      "sequence",
      "sequenceDiagram\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice\n",
      ["Alice", "Bob", "Hello Bob"],
      "rect, line",
    ],
    [
      "class",
      "classDiagram\n  class Animal {\n    +name\n  }\n  Animal <|-- Dog\n",
      ["Animal", "Dog", "name"],
      "path, rect",
    ],
  ])(
    "keeps text and shapes of a %s diagram",
    async (_n, source, words, shapes) => {
      render(<MermaidDiagram source={source} />);
      const el = await screen.findByRole("img", { name: "Mermaid diagram" }, { timeout: 20000 });
      for (const w of words) expect(el.textContent).toContain(w);
      expect(el.querySelectorAll(shapes).length).toBeGreaterThan(0);
      expect(el.querySelector("foreignObject")).toBeNull();
    },
    30000,
  );

  it("ignores a themeCSS directive (secure key) so author CSS never reaches the SVG", async () => {
    const source =
      'graph TD\n  A-->B\n%%{init: {"themeCSS": ".node{fill:url(https://example.invalid/t.png)}"}}%%';
    render(<MermaidDiagram source={source} />);
    const el = await screen.findByRole("img", { name: "Mermaid diagram" }, { timeout: 20000 });
    expect(el.innerHTML).not.toContain("example.invalid");
  }, 30000);
});
