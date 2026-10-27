// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram, resetMermaidForTests } from "./mermaid-diagram";
import { MermaidEnhancer } from "./mermaid-enhancer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  resolvedTheme: undefined as string | undefined,
}));

vi.mock("mermaid", () => ({ default: { initialize: mock.initialize, render: mock.render } }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mock.resolvedTheme }) }));

const svgFor = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;

beforeEach(() => {
  mock.initialize.mockReset();
  mock.render.mockReset();
  mock.resolvedTheme = "light";
  // The SVG text records which theme was initialized when it was rendered.
  mock.render.mockImplementation(async (_id: string, source: string) => {
    const label = (mock.initialize.mock.lastCall?.[0] as { themeVariables: { darkMode: boolean } })
      .themeVariables.darkMode
      ? "dark"
      : "light";
    return { svg: svgFor(`${source}:${label}`) };
  });
  resetMermaidForTests();
});

afterEach(cleanup);

const initTheme = (call: number) =>
  (mock.initialize.mock.calls[call]?.[0] as {
    theme: string;
    themeVariables: { darkMode: boolean };
    securityLevel: string;
  }) ?? {};

describe("theme-aware diagrams", () => {
  it("initializes with the light theme and strict security", async () => {
    render(<MermaidDiagram source="a" />);
    expect((await screen.findByRole("img")).textContent).toBe("a:light");
    expect(initTheme(0)).toMatchObject({
      theme: "base",
      themeVariables: { darkMode: false },
      securityLevel: "strict",
    });
  });

  it("re-initializes and re-renders when the resolved theme becomes dark", async () => {
    const { rerender } = render(<MermaidDiagram source="a" />);
    await screen.findByRole("img");
    mock.resolvedTheme = "dark";
    rerender(<MermaidDiagram source="a" />);
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("a:dark"));
    expect(mock.initialize).toHaveBeenCalledTimes(2);
    expect(initTheme(1)).toMatchObject({
      theme: "base",
      themeVariables: { darkMode: true },
      securityLevel: "strict",
    });
    expect(mock.render).toHaveBeenCalledTimes(2);
  });

  it("switches back to light", async () => {
    mock.resolvedTheme = "dark";
    const { rerender } = render(<MermaidDiagram source="a" />);
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("a:dark"));
    mock.resolvedTheme = "light";
    rerender(<MermaidDiagram source="a" />);
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("a:light"));
    expect(initTheme(1).themeVariables.darkMode).toBe(false);
  });

  it("keeps the previous SVG on screen until the new one is ready", async () => {
    const { rerender } = render(<MermaidDiagram source="a" />);
    await screen.findByRole("img");
    let release: (v: { svg: string }) => void = () => undefined;
    mock.render.mockImplementationOnce(() => new Promise((r) => (release = r)));
    mock.resolvedTheme = "dark";
    rerender(<MermaidDiagram source="a" />);
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img").textContent).toBe("a:light");
    expect(document.querySelector("[aria-busy=true]")).toBeNull();
    await act(async () => {
      release({ svg: svgFor("a:dark") });
    });
    expect(screen.getByRole("img").textContent).toBe("a:dark");
  });

  it("drops a late result for the old theme", async () => {
    let releaseOld: (v: { svg: string }) => void = () => undefined;
    mock.render.mockImplementationOnce(() => new Promise((r) => (releaseOld = r)));
    const { rerender } = render(<MermaidDiagram source="a" />);
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(1));
    mock.resolvedTheme = "dark";
    rerender(<MermaidDiagram source="a" />);
    // The old render is still running, so the new one is queued behind it.
    await act(async () => {
      releaseOld({ svg: svgFor("a:OLD") });
    });
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("a:dark"));
    expect(screen.queryByText("a:OLD")).toBeNull();
  });

  it("does not render again when the theme is unchanged", async () => {
    const { rerender } = render(<MermaidDiagram source="a" />);
    await screen.findByRole("img");
    rerender(<MermaidDiagram source="a" />);
    rerender(<MermaidDiagram source="a" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mock.render).toHaveBeenCalledTimes(1);
    expect(mock.initialize).toHaveBeenCalledTimes(1);
  });

  it("does not re-import mermaid on a theme change", async () => {
    const { rerender } = render(<MermaidDiagram source="a" />);
    await screen.findByRole("img");
    mock.resolvedTheme = "dark";
    rerender(<MermaidDiagram source="a" />);
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("a:dark"));
    // Same mocked module object; initialize/render come from one import.
    expect(mock.render).toHaveBeenCalledTimes(2);
  });

  it("treats an undefined resolved theme as light", async () => {
    mock.resolvedTheme = undefined;
    render(<MermaidDiagram source="a" />);
    await screen.findByRole("img");
    expect(initTheme(0).themeVariables.darkMode).toBe(false);
  });

  it("an explicit theme prop wins over the hook", async () => {
    mock.resolvedTheme = "light";
    render(<MermaidDiagram source="a" theme="dark" />);
    expect((await screen.findByRole("img")).textContent).toBe("a:dark");
    expect(mock.initialize).toHaveBeenCalledTimes(1);
  });

  it("MermaidEnhancer follows the hook and re-renders every diagram", async () => {
    const html =
      '<pre class="dmr-mermaid"><code class="language-mermaid">x</code></pre>' +
      '<pre class="dmr-mermaid"><code class="language-mermaid">y</code></pre>';
    const doc = (
      <MermaidEnhancer>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </MermaidEnhancer>
    );
    const { rerender } = render(doc);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    mock.resolvedTheme = "dark";
    rerender(
      <MermaidEnhancer>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </MermaidEnhancer>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("img").map((e) => e.textContent)).toEqual(["x:dark", "y:dark"]),
    );
    expect(mock.initialize).toHaveBeenCalledTimes(2);
  });

  it("MermaidEnhancer: explicit theme prop wins", async () => {
    mock.resolvedTheme = "dark";
    render(
      <MermaidEnhancer theme="light">
        <div
          dangerouslySetInnerHTML={{
            __html: '<pre class="dmr-mermaid"><code class="language-mermaid">x</code></pre>',
          }}
        />
      </MermaidEnhancer>,
    );
    expect((await screen.findByRole("img")).textContent).toBe("x:light");
  });
});
