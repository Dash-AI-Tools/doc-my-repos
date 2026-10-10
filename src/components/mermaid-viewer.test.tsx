// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
const nativeShowModal = proto.showModal;
const nativeClose = proto.close;

/** The subset of the native modal behavior the component relies on. */
function installDialogPolyfill() {
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

beforeEach(() => {
  mock.initialize.mockReset();
  mock.render.mockReset();
  mock.resolvedTheme = "light";
  mock.render.mockImplementation(async (id: string, source: string) => {
    const theme = (mock.initialize.mock.lastCall?.[0] as { theme: string }).theme;
    return { svg: svgFor(`${source}:${theme}:${id}`) };
  });
  resetMermaidForTests();
  document.documentElement.style.overflow = "";
});

afterEach(() => {
  cleanup();
  proto.showModal = nativeShowModal;
  proto.close = nativeClose;
  document.documentElement.style.overflow = "";
});

async function renderReady(theme?: "light" | "dark") {
  const view = render(<MermaidDiagram source="a" theme={theme} />);
  await screen.findByRole("img", { name: "Mermaid diagram" });
  return view;
}

const trigger = () => screen.getByRole("button", { name: "Enlarge diagram" });
const dialog = () => screen.getByRole("dialog");
const content = () => screen.getByTestId("mermaid-viewer-content");
const stage = () => screen.getByRole("group", { name: /pan and zoom area/i });

async function openDialog() {
  fireEvent.click(trigger());
  await waitFor(() => expect(within(dialog()).getByTestId("mermaid-viewer-content")).toBeTruthy());
}

const transformOf = () => content().style.transform;
const percent = () => screen.getByRole("button", { name: /reset zoom/i }).textContent;

describe.each([
  ["with native showModal", true],
  ["without showModal (fallback)", false],
])("enlarge view %s", (_name, native) => {
  beforeEach(() => {
    if (native) installDialogPolyfill();
    else proto.showModal = undefined;
  });

  it("shows an Enlarge button on a ready diagram and no dialog yet", async () => {
    await renderReady();
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("opens a labelled modal dialog with its own copy of the diagram", async () => {
    await renderReady();
    await openDialog();
    const d = dialog();
    expect(d.getAttribute("aria-modal")).toBe("true");
    const labelledBy = d.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toBe("Diagram");
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBe(d);
    // The inline diagram stays, and the copy has its own element ids.
    const inline = screen.getByRole("img", { name: "Mermaid diagram" });
    expect(inline.querySelector("svg")).not.toBeNull();
    expect(d.querySelector("svg")).not.toBeNull();
    const ids = mock.render.mock.calls.map((c) => c[0] as string);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("closes on Escape and returns focus to the Enlarge button", async () => {
    await renderReady();
    await openDialog();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on the native cancel event", async () => {
    await renderReady();
    await openDialog();
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog(), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes with the Close button", async () => {
    await renderReady();
    await openDialog();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a backdrop click but not on clicks inside the panel", async () => {
    await renderReady();
    await openDialog();
    const d = dialog();
    const panel = d.firstElementChild as HTMLElement;
    fireEvent.pointerDown(panel);
    fireEvent.click(panel);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // Press inside, release on the backdrop (a drag that ends outside): stays open.
    fireEvent.pointerDown(panel);
    fireEvent.click(d);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.pointerDown(d);
    fireEvent.click(d);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("moves focus into the dialog and locks page scroll while open", async () => {
    document.documentElement.style.overflow = "scroll";
    await renderReady();
    await openDialog();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(stage());
    expect(document.documentElement.style.overflow).toBe("hidden");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(document.documentElement.style.overflow).toBe("scroll");
  });

  it("zooms with the buttons and clamps at both limits", async () => {
    await renderReady();
    await openDialog();
    expect(percent()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(percent()).toBe("125%");
    expect(transformOf()).toContain("scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(percent()).toBe("80%");
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(percent()).toBe("800%");
    for (let i = 0; i < 60; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(percent()).toBe("25%");
    fireEvent.click(screen.getByRole("button", { name: /reset zoom/i }));
    expect(percent()).toBe("100%");
    expect(transformOf()).toBe("translate(0px, 0px) scale(1)");
  });

  it("pans with the arrow keys and zooms with + - and 0", async () => {
    await renderReady();
    await openDialog();
    const press = (key: string, init: object = {}) => fireEvent.keyDown(stage(), { key, ...init });
    press("ArrowRight");
    expect(transformOf()).toBe("translate(48px, 0px) scale(1)");
    press("ArrowDown");
    press("ArrowLeft", { shiftKey: true });
    expect(transformOf()).toBe("translate(-144px, 48px) scale(1)");
    press("ArrowUp");
    expect(transformOf()).toBe("translate(-144px, 0px) scale(1)");
    press("+");
    expect(percent()).toBe("125%");
    press("=");
    press("-");
    press("_");
    expect(percent()).toBe("100%");
    press("+");
    press("0");
    expect(transformOf()).toBe("translate(0px, 0px) scale(1)");
  });

  it("does not react to modified keys or unrelated keys", async () => {
    await renderReady();
    await openDialog();
    fireEvent.keyDown(stage(), { key: "+", ctrlKey: true });
    fireEvent.keyDown(stage(), { key: "a" });
    expect(transformOf()).toBe("translate(0px, 0px) scale(1)");
  });

  it("zooms with the wheel and stops the page from scrolling", async () => {
    await renderReady();
    await openDialog();
    const up = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    stage().dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    await waitFor(() => expect(Number(percent()?.replace("%", ""))).toBeGreaterThan(100));
  });

  it("pans by dragging with the pointer", async () => {
    await renderReady();
    await openDialog();
    const s = stage();
    fireEvent.pointerDown(s, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(s, { pointerId: 1, pointerType: "mouse", clientX: 130, clientY: 85 });
    expect(transformOf()).toBe("translate(30px, -15px) scale(1)");
    fireEvent.pointerMove(s, { pointerId: 1, pointerType: "mouse", clientX: 140, clientY: 85 });
    expect(transformOf()).toBe("translate(40px, -15px) scale(1)");
    fireEvent.pointerUp(s, { pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(s, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 300 });
    expect(transformOf()).toBe("translate(40px, -15px) scale(1)");
  });

  it("ignores non-primary mouse buttons when dragging", async () => {
    await renderReady();
    await openDialog();
    const s = stage();
    fireEvent.pointerDown(s, {
      pointerId: 1,
      pointerType: "mouse",
      button: 2,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(s, { pointerId: 1, pointerType: "mouse", clientX: 50, clientY: 50 });
    expect(transformOf()).toBe("translate(0px, 0px) scale(1)");
  });

  it("pinches with two pointers", async () => {
    await renderReady();
    await openDialog();
    const s = stage();
    fireEvent.pointerDown(s, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerDown(s, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(s, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    // Distance 100 -> 200: twice the scale.
    expect(percent()).toBe("200%");
  });

  it("starts from the initial view every time it opens", async () => {
    await renderReady();
    await openDialog();
    fireEvent.keyDown(stage(), { key: "+" });
    fireEvent.keyDown(stage(), { key: "ArrowRight" });
    expect(percent()).toBe("125%");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await openDialog();
    expect(percent()).toBe("100%");
    expect(transformOf()).toBe("translate(0px, 0px) scale(1)");
  });

  it("renders the dialog copy with the current theme", async () => {
    mock.resolvedTheme = "dark";
    render(<MermaidDiagram source="a" />);
    await screen.findByRole("img", { name: "Mermaid diagram" });
    await openDialog();
    expect(content().textContent).toContain("a:dark");
    expect(mock.initialize.mock.lastCall?.[0]).toMatchObject({
      theme: "dark",
      securityLevel: "strict",
    });
  });

  it("shows a fixed message when the dialog copy cannot be rendered", async () => {
    await renderReady();
    mock.render.mockRejectedValueOnce(new Error("secret internal detail <b>x</b>"));
    fireEvent.click(trigger());
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toBe("The enlarged diagram could not be rendered.");
    expect(dialog().innerHTML).not.toContain("secret");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(document.activeElement).toBe(trigger());
  });

  it("shows a busy state until the dialog copy is ready", async () => {
    await renderReady();
    let release: (v: { svg: string }) => void = () => undefined;
    mock.render.mockImplementationOnce(() => new Promise((r) => (release = r)));
    fireEvent.click(trigger());
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(2));
    expect(dialog().querySelector("[aria-busy=true]")).not.toBeNull();
    await act(async () => {
      release({ svg: svgFor("late") });
    });
    expect(content().textContent).toBe("late");
  });
});

describe("enlarge button states", () => {
  it("has no enlarge button while loading", () => {
    mock.render.mockImplementation(() => new Promise(() => undefined));
    render(<MermaidDiagram source="a" />);
    expect(document.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Enlarge diagram" })).toBeNull();
  });

  it("has no enlarge button in the error state", async () => {
    mock.render.mockRejectedValue(new Error("Parse error"));
    render(<MermaidDiagram source="a" />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("has no enlarge button for an empty diagram", () => {
    render(<MermaidDiagram source="  " />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the diagram element and its svg unchanged", async () => {
    await renderReady();
    const img = screen.getByRole("img", { name: "Mermaid diagram" });
    expect(img.matches("div.dmr-mermaid-diagram")).toBe(true);
    expect(img.innerHTML).toMatch(/^<svg[^>]*><text>a:default:dmr-mermaid-[\w-]+<\/text><\/svg>$/);
    expect(img.parentElement?.classList.contains("dmr-mermaid-viewer")).toBe(true);
  });
});

describe("with the enhancer", () => {
  const html =
    '<p>intro</p><pre class="dmr-mermaid"><code class="language-mermaid">graph TD;A--&gt;B</code></pre>';

  it("adds one button per diagram, none twice on re-render, and cleans up on unmount", async () => {
    installDialogPolyfill();
    const { rerender, unmount } = render(
      <MermaidEnhancer theme="light">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </MermaidEnhancer>,
    );
    await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(screen.getAllByRole("button", { name: "Enlarge diagram" })).toHaveLength(1);
    rerender(
      <MermaidEnhancer theme="light">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </MermaidEnhancer>,
    );
    await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(screen.getAllByRole("button", { name: "Enlarge diagram" })).toHaveLength(1);

    fireEvent.click(trigger());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
    expect(document.documentElement.style.overflow).toBe("hidden");
    unmount();
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector("button")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("re-renders the open dialog copy when the theme changes", async () => {
    installDialogPolyfill();
    const doc = <div dangerouslySetInnerHTML={{ __html: html }} />;
    const { rerender } = render(<MermaidEnhancer theme="light">{doc}</MermaidEnhancer>);
    await screen.findByRole("img", { name: "Mermaid diagram" });
    await openDialog();
    expect(content().textContent).toContain(":default:");
    rerender(<MermaidEnhancer theme="dark">{doc}</MermaidEnhancer>);
    await waitFor(() => expect(content().textContent).toContain(":dark:"));
  });
});
