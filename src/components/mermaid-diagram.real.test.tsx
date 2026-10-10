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
