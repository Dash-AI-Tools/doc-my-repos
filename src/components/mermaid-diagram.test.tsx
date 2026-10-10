// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram, resetMermaidForTests, usesImageShape } from "./mermaid-diagram";
import { MermaidEnhancer } from "./mermaid-enhancer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => {
  return { default: { initialize: mock.initialize, render: mock.render } };
});

const svgFor = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;

beforeEach(() => {
  mock.initialize.mockReset();
  mock.render.mockReset();
  mock.render.mockImplementation(async (_id: string, source: string) => ({ svg: svgFor(source) }));
  resetMermaidForTests();
});

afterEach(() => {
  cleanup();
});

describe("MermaidDiagram", () => {
  it("renders the SVG that mermaid returns, with an accessible name", async () => {
    render(<MermaidDiagram source="graph TD; A-->B;" />);
    const img = await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(img.querySelector("svg text")?.textContent).toBe("graph TD; A-->B;");
  });

  it("shows the source while loading", () => {
    mock.render.mockImplementation(() => new Promise(() => undefined));
    render(<MermaidDiagram source="graph TD" />);
    expect(document.querySelector("pre code")?.textContent).toBe("graph TD");
    expect(document.querySelector("[aria-busy=true]")).not.toBeNull();
  });

  it("initializes once with the strict security level and no loosening", async () => {
    render(
      <>
        <MermaidDiagram source="a" />
        <MermaidDiagram source="b" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(mock.initialize).toHaveBeenCalledTimes(1);
    const config = mock.initialize.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.securityLevel).toBe("strict");
    expect(config.startOnLoad).toBe(false);
    expect(config.theme).toBe("base");
    expect(config.themeVariables).toMatchObject({ darkMode: false });
    expect(config.maxTextSize).toBeGreaterThan(0);
    expect(config.maxEdges).toBeGreaterThan(0);
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart).toEqual({ htmlLabels: false });
    expect(config.class).toEqual({ htmlLabels: false });
    expect(config.secure).toEqual(
      expect.arrayContaining(["securityLevel", "htmlLabels", "flowchart", "class", "themeCSS"]),
    );
    expect(config).not.toHaveProperty("dompurifyConfig");
    expect(JSON.stringify(config)).not.toMatch(/loose|sandbox/);
  });

  it("re-initializes only when the theme input changes", async () => {
    const { rerender } = render(<MermaidDiagram source="a" theme="light" />);
    await screen.findByRole("img");
    rerender(<MermaidDiagram source="a" theme="dark" />);
    await waitFor(() => expect(mock.initialize).toHaveBeenCalledTimes(2));
    expect(
      mock.initialize.mock.calls[1]?.[0] as { theme: string; securityLevel: string },
    ).toMatchObject({
      theme: "base",
      themeVariables: { darkMode: true },
      securityLevel: "strict",
    });
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(2));
  });

  it("uses a safe, distinct id for each render call", async () => {
    render(
      <>
        <MermaidDiagram source="a" />
        <MermaidDiagram source="b" />
      </>,
    );
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(2));
    const ids = mock.render.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });

  it("never runs two renders at once", async () => {
    let active = 0;
    let maxActive = 0;
    mock.render.mockImplementation(async (_id: string, source: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { svg: svgFor(source) };
    });
    render(
      <>
        <MermaidDiagram source="a" />
        <MermaidDiagram source="b" />
        <MermaidDiagram source="c" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(3));
    expect(maxActive).toBe(1);
  });

  it("drops a stale result when the source changes", async () => {
    let releaseFirst: (v: { svg: string }) => void = () => undefined;
    mock.render.mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)));
    const { rerender } = render(<MermaidDiagram source="old" />);
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(1));
    rerender(<MermaidDiagram source="new" />);
    await act(async () => {
      releaseFirst({ svg: svgFor("old") });
    });
    const img = await screen.findByRole("img");
    expect(img.textContent).toBe("new");
    expect(screen.queryByText("old")).toBeNull();
  });

  it("does not update after unmount", async () => {
    let release: (v: { svg: string }) => void = () => undefined;
    mock.render.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<MermaidDiagram source="a" />);
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      release({ svg: svgFor("a") });
    });
    expect(spy).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe("<div></div>");
    spy.mockRestore();
  });

  it("shows the source and the message as text when rendering fails", async () => {
    mock.render.mockRejectedValue(new Error("Parse error on line 2 <b>x</b>"));
    render(<MermaidDiagram source={"graph TD\n<img src=x onerror=alert(1)>"} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Parse error on line 2 <b>x</b>");
    expect(alert.querySelector("b")).toBeNull();
    expect(document.querySelector("pre code")?.textContent).toBe(
      "graph TD\n<img src=x onerror=alert(1)>",
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("recovers after an error: the next diagram still renders", async () => {
    mock.render.mockRejectedValueOnce(new Error("bad"));
    render(
      <>
        <MermaidDiagram source="bad" />
        <MermaidDiagram source="good" />
      </>,
    );
    await screen.findByRole("alert");
    expect((await screen.findByRole("img")).textContent).toBe("good");
  });

  it("removes mermaid's scratch elements after a failed render", async () => {
    mock.render.mockImplementation(async (id: string) => {
      const scratch = document.createElement("div");
      scratch.id = `d${id}`;
      document.body.appendChild(scratch);
      throw new Error("bad");
    });
    render(<MermaidDiagram source="x" />);
    await screen.findByRole("alert");
    expect(document.querySelector("[id^='dmr-mermaid-']:not([role])")).toBeNull();
  });
});

describe("MermaidEnhancer", () => {
  const HTML =
    '<p>hi</p><pre class="dmr-mermaid"><code class="language-mermaid">graph TD; A--&gt;B\n</code></pre>' +
    '<pre><code class="language-ts">const a = 1;</code></pre>' +
    '<pre class="dmr-mermaid"><code class="language-mermaid">pie\n  "a": 1\n</code></pre>';

  function Doc({ html = HTML }: { html?: string }) {
    return (
      <MermaidEnhancer>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </MermaidEnhancer>
    );
  }

  it("renders a diagram per block from the text content and hides the source pre", async () => {
    const { container } = render(<Doc />);
    await waitFor(() =>
      expect(screen.getAllByRole("img", { name: "Mermaid diagram" })).toHaveLength(2),
    );
    expect(mock.render.mock.calls.map((c) => c[1])).toEqual([
      "graph TD; A-->B\n",
      'pie\n  "a": 1\n',
    ]);
    const pres = container.querySelectorAll<HTMLElement>("pre.dmr-mermaid");
    for (const pre of pres) {
      expect(pre.hidden).toBe(true);
      expect(pre.nextElementSibling?.classList.contains("dmr-mermaid-host")).toBe(true);
    }
    expect(container.querySelector("pre:not(.dmr-mermaid)")?.hasAttribute("hidden")).toBe(false);
  });

  it("is idempotent across re-renders: one host and one diagram per block", async () => {
    const { container, rerender } = render(<Doc />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    rerender(<Doc />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(container.querySelectorAll(".dmr-mermaid-host")).toHaveLength(2);
  });

  it("restores the source pre and removes the hosts on unmount", async () => {
    const { container, unmount } = render(<Doc />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    const pres = Array.from(container.querySelectorAll<HTMLElement>("pre.dmr-mermaid"));
    unmount();
    for (const pre of pres) expect(pre.hidden).toBe(false);
    expect(document.querySelector(".dmr-mermaid-host")).toBeNull();
  });

  it("shows the error UI inside the host for an invalid diagram", async () => {
    mock.render.mockRejectedValue(new Error("Syntax error in text"));
    render(<Doc />);
    expect(await screen.findAllByRole("alert")).toHaveLength(2);
  });
});

describe("sanitizing", () => {
  it("inserts only the sanitized SVG: no img, image or foreignObject reaches the DOM", async () => {
    mock.render.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="https://example.invalid/x"></foreignObject><image href="https://example.invalid/y"/><text>kept</text></svg>`,
    });
    render(<MermaidDiagram source="a" />);
    const el = await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(el.querySelector("img, image, foreignObject")).toBeNull();
    expect(el.textContent).toBe("kept");
  });

  it("shows the source and a fixed alert when the SVG cannot be sanitized", async () => {
    mock.render.mockResolvedValue({ svg: "<div>not svg</div>" });
    render(<MermaidDiagram source="a" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The diagram could not be rendered safely.");
  });
});

describe("image shapes", () => {
  it.each([
    ['A@{ img: "https://example.invalid/x.png", label: "x" }', true],
    ["A@{\n  img: 'https://example.invalid/x.png'\n}", true],
    ['A@{ "IMG": "u" }', true],
    ["A[plain] --> B", false],
    ["graph TD\n  A@{ shape: rect }", false],
  ])("detects %j -> %s", (source, expected) => {
    expect(usesImageShape(source)).toBe(expected);
  });

  it("never calls mermaid for an image shape and shows the source with an alert", async () => {
    mock.render.mockClear();
    render(<MermaidDiagram source={'graph TD\n  A@{ img: "https://example.invalid/x.png" }'} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Image shapes are not supported in diagrams.");
    expect(mock.render).not.toHaveBeenCalled();
  });
});
