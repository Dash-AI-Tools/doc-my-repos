// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaletteHit } from "@docmyrepos/core/internal/palette";
import { HIGHLIGHT_END as E, HIGHLIGHT_START as S } from "@docmyrepos/core/internal/search";

import { CommandPalette, DEBOUNCE_MS, isPaletteShortcut } from "./command-palette";
import { openPalette, resetPaletteForTests } from "./palette-store";
import { PaletteTrigger } from "./palette-trigger";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ push: vi.fn(), pathname: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.pathname,
}));

const fetchMock = vi.fn<typeof fetch>();

const proto = HTMLDialogElement.prototype as {
  showModal?: () => void;
  close?: () => void;
};
const nativeShowModal = proto.showModal;
const nativeClose = proto.close;

/** The subset of the native modal behavior the component relies on. */
function installDialogPolyfill(): void {
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

beforeEach(() => {
  installDialogPolyfill();
  nav.push.mockReset();
  nav.pathname = "/";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  document.documentElement.style.overflow = "";
});

afterEach(() => {
  cleanup();
  resetPaletteForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  proto.showModal = nativeShowModal;
  proto.close = nativeClose;
  document.documentElement.style.overflow = "";
});

function hit(n: number, over: Partial<PaletteHit> = {}): PaletteHit {
  return {
    key: `1:docs/doc-${n}.md`,
    title: `Doc ${n}`,
    href: `/acme/api/docs/doc-${n}`,
    repoLabel: "acme/api",
    path: `docs/doc-${n}.md`,
    section: null,
    snippet: `a ${S}deployment${E} note ${n}`,
    isPrivate: false,
    ...over,
  };
}

function answer(hits: PaletteHit[], total = hits.length): Response {
  return new Response(JSON.stringify({ q: "x", total, hits, seeAll: "/search?q=x" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const input = () => screen.getByRole("combobox");
const options = () => screen.queryAllByRole("option");
const shortcut = (init: KeyboardEventInit = { ctrlKey: true }, target: Element = document.body) =>
  fireEvent.keyDown(target, { key: "k", ...init });

function type(value: string): void {
  fireEvent.change(input(), { target: { value } });
}

/** Types, waits out the debounce and for the answer to be on screen. */
async function search(
  value: string,
  hits: PaletteHit[] = [hit(1), hit(2), hit(3)],
  total?: number,
) {
  fetchMock.mockResolvedValueOnce(answer(hits, total));
  type(value);
  if (hits.length > 0) await waitFor(() => expect(options()).toHaveLength(hits.length));
  else await waitFor(() => expect(screen.getByTestId("palette-empty")).toBeTruthy());
}

/**
 * Clicks and reports whether the component took the click over (called preventDefault). A
 * document listener, which runs after React's, records that and then cancels the click so jsdom
 * does not try to navigate.
 */
function clickTakenOver(element: Element, init: MouseEventInit = {}): boolean {
  let taken = false;
  const record = (event: Event) => {
    taken = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", record);
  fireEvent.click(element, init);
  document.removeEventListener("click", record);
  return taken;
}

function renderPalette() {
  return render(<CommandPalette />);
}

async function openByShortcut(): Promise<void> {
  shortcut();
  await screen.findByRole("dialog");
}

describe("isPaletteShortcut", () => {
  const base = { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  it("is Ctrl+K or Cmd+K, either case, without Alt or Shift", () => {
    expect(isPaletteShortcut(base)).toBe(true);
    expect(isPaletteShortcut({ ...base, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "K" })).toBe(true);
    expect(isPaletteShortcut({ ...base, ctrlKey: false })).toBe(false);
    expect(isPaletteShortcut({ ...base, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "j" })).toBe(false);
  });

  it("uses the physical key only for a non-Latin layout, never to take another Latin letter", () => {
    expect(isPaletteShortcut({ ...base, key: "л", code: "KeyK" })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "v", code: "KeyK" })).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "л", code: "KeyJ" })).toBe(false);
  });
});

describe("opening and closing", () => {
  it.each([
    ["Ctrl+K", { ctrlKey: true }],
    ["Cmd+K", { metaKey: true }],
  ])("%s opens a labelled modal with the input focused", async (_name, init) => {
    renderPalette();
    expect(screen.queryByRole("dialog")).toBeNull();
    shortcut(init);
    const dialog = await screen.findByRole("dialog", { name: "Quick search" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-controls")).toBeNull();
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(screen.getByLabelText("Search documentation pages")).toBe(input());
    expect(input().getAttribute("maxlength")).toBe("256");
    expect(screen.getByTestId("palette-hint")).toBeTruthy();
    // the shortcut is taken from the browser
    expect(fireEvent.keyDown(document.body, { key: "k", ...init })).toBe(false);
  });

  it("toggles: the shortcut again closes it", async () => {
    renderPalette();
    await openByShortcut();
    shortcut();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    shortcut();
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("works while focus is in a text field, and returns focus there on close", async () => {
    render(
      <>
        <input aria-label="other" />
        <textarea aria-label="area" />
        <div contentEditable suppressContentEditableWarning aria-label="editable" tabIndex={0} />
        <CommandPalette />
      </>,
    );
    for (const name of ["other", "area", "editable"]) {
      const field = screen.getByLabelText(name);
      field.focus();
      shortcut({ ctrlKey: true }, field);
      await screen.findByRole("dialog");
      expect(document.activeElement).toBe(input());
      fireEvent.keyDown(input(), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(field);
    }
  });

  it("ignores other keys, Alt and Shift combinations, key repeat and IME composition", async () => {
    renderPalette();
    shortcut({});
    shortcut({ ctrlKey: true, shiftKey: true });
    shortcut({ ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, isComposing: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    // a held key does not flicker the palette open and shut
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, repeat: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape, on the Close button and on a click on the backdrop", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await openByShortcut();
    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await openByShortcut();
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not close when a click inside the panel started on the backdrop-free panel", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent.pointerDown(input());
    fireEvent.click(input());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not close on Escape during IME composition", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent.keyDown(input(), { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes when the native cancel event fires (Escape in a real browser)", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("locks page scroll while open and restores it", async () => {
    document.documentElement.style.overflow = "scroll";
    renderPalette();
    await openByShortcut();
    expect(document.documentElement.style.overflow).toBe("hidden");
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.documentElement.style.overflow).toBe("scroll");
  });

  it("uses the native showModal when there is one", async () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    proto.showModal = showModal;
    renderPalette();
    await openByShortcut();
    expect(showModal).toHaveBeenCalledOnce();
  });

  it("falls back to the open attribute when showModal is missing or throws", async () => {
    proto.showModal = undefined;
    renderPalette();
    await openByShortcut();
    expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
    cleanup();
    resetPaletteForTests();
    proto.showModal = () => {
      throw new Error("not allowed");
    };
    renderPalette();
    await openByShortcut();
    expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
  });

  it("starts empty every time it opens", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    shortcut();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openByShortcut();
    expect((input() as HTMLInputElement).value).toBe("");
    expect(options()).toHaveLength(0);
  });

  it("closes on a route change", async () => {
    const { rerender } = renderPalette();
    await openByShortcut();
    nav.pathname = "/acme/api";
    rerender(<CommandPalette />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("registers one window listener, removes it on unmount, and not twice after a remount", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const keydown = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "keydown");
    const first = renderPalette();
    expect(keydown(add)).toHaveLength(1);
    first.unmount();
    expect(keydown(remove)).toHaveLength(1);
    expect(keydown(remove)[0]?.[1]).toBe(keydown(add)[0]?.[1]);

    renderPalette();
    expect(keydown(add)).toHaveLength(2);
    // one listener alive: a single press opens, it does not open and close again
    shortcut();
    await screen.findByRole("dialog");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not open from the shortcut after unmount", () => {
    renderPalette().unmount();
    shortcut();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("live search", () => {
  it("waits for a pause in typing and sends one request for the last text", async () => {
    renderPalette();
    await openByShortcut();
    fetchMock.mockResolvedValue(answer([hit(1)]));
    type("d");
    type("de");
    type("dep");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS - 60));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/search?q=dep&limit=8");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
  });

  it("normalizes the query, and does not search for blank text", async () => {
    renderPalette();
    await openByShortcut();
    type("   ");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("palette-hint")).toBeTruthy();
    fetchMock.mockResolvedValue(answer([hit(1)]));
    type("  a   b  ");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/search?q=a+b&limit=8");
  });

  it("does not repeat a request when only trailing space is typed", async () => {
    renderPalette();
    await openByShortcut();
    await search("abc");
    type("abc ");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels the request in flight when the query changes, and when the palette closes", async () => {
    renderPalette();
    await openByShortcut();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    type("one");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const first = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(first?.aborted).toBe(false);
    type("two");
    expect(first?.aborted).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(second?.aborted).toBe(false);
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(second?.aborted).toBe(true);
  });

  it("ignores the answer to a superseded query, whatever order the answers arrive in", async () => {
    renderPalette();
    await openByShortcut();
    const resolvers: ((r: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    type("a");
    await waitFor(() => expect(resolvers).toHaveLength(1));
    type("ab");
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]?.(answer([hit(2, { title: "Answer to ab" })]));
    });
    await screen.findByText("Answer to ab");
    await act(async () => {
      resolvers[0]?.(answer([hit(1, { title: "Answer to a" })]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText("Answer to a")).toBeNull();
    expect(screen.getByText("Answer to ab")).toBeTruthy();
  });

  it("shows the hint for an empty query and returns to it when the text is cleared", async () => {
    renderPalette();
    await openByShortcut();
    expect(screen.getByTestId("palette-hint").textContent).toMatch(/Search the documentation/);
    expect(screen.queryByTestId("palette-see-all")).toBeNull();
    await search("deploy");
    type("");
    expect(screen.getByTestId("palette-hint")).toBeTruthy();
    expect(options()).toHaveLength(0);
    expect(screen.queryByTestId("palette-see-all")).toBeNull();
  });

  it("shows a loading state, marks the body busy, and then the results", async () => {
    renderPalette();
    await openByShortcut();
    let resolve: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    type("slow");
    expect(screen.getByTestId("palette-loading")).toBeTruthy();
    expect(screen.getByTestId("palette-body").getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => resolve?.(answer([hit(1)])));
    await screen.findByRole("option");
    expect(screen.getByTestId("palette-body").getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByTestId("palette-loading")).toBeNull();
  });

  it("keeps the previous list, busy, until the next answer arrives", async () => {
    renderPalette();
    await openByShortcut();
    await search("one");
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    type("two");
    expect(options()).toHaveLength(3);
    expect(screen.getByTestId("palette-body").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("palette-busy")).toBeTruthy();
  });

  it("shows the empty state with the query as text", async () => {
    renderPalette();
    await openByShortcut();
    await search("<b>nothing</b>", []);
    expect(screen.getByTestId("palette-empty").textContent).toBe(
      "No results for “<b>nothing</b>”.",
    );
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByTestId("palette-status").textContent).toBe("No results");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("palette-see-all")).toBeTruthy();
  });

  it.each([
    ["a server error", () => fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }))],
    ["a network error", () => fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))],
    ["a body that is not JSON", () => fetchMock.mockResolvedValueOnce(new Response("<html>"))],
    ["JSON of the wrong shape", () => fetchMock.mockResolvedValueOnce(new Response('{"hits":3}'))],
  ])("shows a non-blocking error for %s", async (_name, arrange) => {
    renderPalette();
    await openByShortcut();
    arrange();
    type("deploy");
    const error = await screen.findByTestId("palette-error");
    expect(error.textContent).toMatch(/Search is unavailable/);
    expect(screen.getByTestId("palette-status").textContent).toBe("Search is unavailable");
    // still usable: the full results page is one link away, and typing again retries
    expect(screen.getByTestId("palette-see-all").getAttribute("href")).toBe("/search?q=deploy");
    fetchMock.mockResolvedValueOnce(answer([hit(1)]));
    type("deploy more");
    await screen.findByRole("option");
    expect(screen.queryByTestId("palette-error")).toBeNull();
  });

  it("opens the full results page with Enter even after an error", async () => {
    renderPalette();
    await openByShortcut();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    type("deploy");
    await screen.findByTestId("palette-error");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/search?q=deploy");
  });

  it("announces the settled count politely", async () => {
    renderPalette();
    await openByShortcut();
    const status = screen.getByTestId("palette-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    await search("deploy", [hit(1), hit(2)], 2);
    expect(status.textContent).toBe("2 results");
    await search("deploy now", [hit(1)], 1);
    await waitFor(() => expect(status.textContent).toBe("1 result"));
    await search("deploy more", [hit(1), hit(2)], 25);
    await waitFor(() => expect(status.textContent).toBe("2 of 25 results"));
  });

  it("links to the full results page for the query, with the text escaped", async () => {
    renderPalette();
    await openByShortcut();
    await search('a "b" <i>c</i> & d');
    const link = screen.getByTestId("palette-see-all") as HTMLAnchorElement;
    expect(link.textContent).toBe('See all results for "a "b" <i>c</i> & d"');
    expect(link.getAttribute("href")).toBe("/search?q=a%20%22b%22%20%3Ci%3Ec%3C%2Fi%3E%20%26%20d");
    expect(document.querySelector("i")).toBeNull();
    fireEvent.click(link);
    expect(nav.push).toHaveBeenCalledWith(link.getAttribute("href"));
  });
});

describe("results", () => {
  it("renders titles, locations, private badges and highlighted snippets as text", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy", [
      hit(1, { section: "Checks" }),
      hit(2, { isPrivate: true, repoLabel: "acme/secret" }),
    ]);
    const [first, second] = options();
    expect(first?.getAttribute("href")).toBe("/acme/api/docs/doc-1");
    expect(within(first as HTMLElement).getByText("Doc 1")).toBeTruthy();
    expect(first?.textContent).toContain("acme/api / docs/doc-1.md");
    expect(first?.textContent).toContain("Checks");
    expect(first?.querySelector("mark")?.textContent).toBe("deployment");
    expect(first?.querySelector("[data-testid=palette-private-badge]")).toBeNull();
    expect(within(second as HTMLElement).getByText("Private")).toBeTruthy();
    expect(second?.textContent).toContain("acme/secret");
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeTruthy();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("renders hostile titles, paths and snippets as plain text", async () => {
    renderPalette();
    await openByShortcut();
    await search("x", [
      hit(1, {
        title: "<script>window.__xss=1</script><img src=x onerror=window.__xss=2>",
        path: "docs/<b>bold</b>.md",
        repoLabel: "acme/<i>x</i>",
        section: "<u>s</u>",
        snippet: `<iframe src="javascript:1"></iframe> ${S}<svg onload=1>${E}`,
      }),
    ]);
    const row = options()[0] as HTMLElement;
    expect(row.querySelector("script, img, b, i, u, iframe, svg")).toBeNull();
    expect(row.textContent).toContain("<script>window.__xss=1</script>");
    expect(row.textContent).toContain("<iframe");
    expect(row.querySelector("mark")?.textContent).toBe("<svg onload=1>");
    expect(document.querySelectorAll("script, iframe, img").length).toBe(0);
    expect("__xss" in window).toBe(false);
  });

  it("drops a row whose link is not an in-app path", async () => {
    renderPalette();
    await openByShortcut();
    await search("x", [
      hit(1),
      hit(2, { href: "https://evil.test/x" }),
      hit(3, { href: "//evil.test/x" }),
      hit(4, { href: "javascript:alert(1)" }),
    ]).catch(() => undefined);
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options().map((o) => o.getAttribute("href"))).toEqual(["/acme/api/docs/doc-1"]);
  });

  it("has no active row at first; ArrowDown and ArrowUp move it, wrapping, via aria-activedescendant", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    const [a, b, c] = options() as HTMLElement[];
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(options().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);

    const press = (key: string) => fireEvent.keyDown(input(), { key });
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(a?.id);
    expect(a?.getAttribute("aria-selected")).toBe("true");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(b?.id);
    expect(a?.getAttribute("aria-selected")).toBe("false");
    press("ArrowDown");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(a?.id);
    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe(c?.id);
    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe(b?.id);
    // focus never leaves the input
    expect(document.activeElement).toBe(input());
    // the arrow keys are taken from the text field (no caret movement)
    expect(fireEvent.keyDown(input(), { key: "ArrowDown" })).toBe(false);
  });

  it("ArrowUp from nothing goes to the last row", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]?.id);
  });

  it("Home and End jump to the ends only while a row is active; otherwise they move the caret", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    expect(fireEvent.keyDown(input(), { key: "End" })).toBe(true);
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(fireEvent.keyDown(input(), { key: "End" })).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]?.id);
    fireEvent.keyDown(input(), { key: "Home" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
  });

  it("arrow keys do nothing without results", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("the mouse moves the active row without taking focus from the input", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    const [, b] = options() as HTMLElement[];
    fireEvent.mouseMove(b as HTMLElement);
    expect(b?.getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(b?.id);
    expect(fireEvent.mouseDown(b as HTMLElement)).toBe(false);
    expect(document.activeElement).toBe(input());
    // the keyboard continues from there
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]?.id);
  });

  it("forgets the active row when the query changes", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).not.toBeNull();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    type("deploy now");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("choosing a result", () => {
  it("Enter opens the active row in the app and closes the palette", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/acme/api/docs/doc-2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Enter with no active row opens the full results page", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy guide");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/search?q=deploy%20guide");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Enter with an empty query does nothing", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("%s+Enter opens the active row in a new tab and keeps the palette", async (_name, init) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderPalette();
    await openByShortcut();
    await search("deploy");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter", ...init });
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "/acme/api/docs/doc-1",
      "_blank",
      "noopener,noreferrer",
    );
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a plain click on a row navigates in the app; a modified click keeps the browser's behavior", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    const [a, b] = options() as HTMLElement[];
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(clickTakenOver(b as HTMLElement, init)).toBe(false);
    }
    expect(nav.push).not.toHaveBeenCalled();
    expect(clickTakenOver(a as HTMLElement)).toBe(true);
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/acme/api/docs/doc-1");
  });

  it("makes the results box a tab stop only while its content overflows", async () => {
    let notify: () => void = () => undefined;
    class FakeResizeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let scrollHeight = 500;
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 300 });
    try {
      renderPalette();
      await openByShortcut();
      await search("deploy");
      const body = screen.getByTestId("palette-body");
      expect(body.hasAttribute("tabindex")).toBe(false);
      act(() => notify());
      expect(body.getAttribute("tabindex")).toBe("0");
      const stops = [
        ...document.querySelectorAll<HTMLElement>("input, a[href], button, [tabindex]"),
      ]
        .filter((el) => el.tabIndex >= 0)
        .map((el) => el.getAttribute("data-testid"));
      expect(stops).toEqual(["palette-input", "palette-body", "palette-see-all", "palette-close"]);
      scrollHeight = 300;
      act(() => notify());
      expect(body.hasAttribute("tabindex")).toBe(false);
    } finally {
      Reflect.deleteProperty(proto, "scrollHeight");
      Reflect.deleteProperty(proto, "clientHeight");
    }
  });

  it("wraps Tab and Shift+Tab inside the dialog", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    const close = screen.getByTestId("palette-close");
    const seeAll = screen.getByTestId("palette-see-all");
    // forward from the last stop goes to the first, and the browser's default is suppressed
    close.focus();
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(input());
    // backward from the first stop goes to the last
    expect(fireEvent.keyDown(input(), { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);
    // in the middle the browser moves focus itself
    seeAll.focus();
    expect(fireEvent.keyDown(seeAll, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(seeAll, { key: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(seeAll);
  });

  it("Tab order: input, then See all results, then Close (rows are not tab stops)", async () => {
    renderPalette();
    await openByShortcut();
    await search("deploy");
    expect(options().every((o) => o.getAttribute("tabindex") === "-1")).toBe(true);
    const focusable = [...document.querySelectorAll<HTMLElement>("input, a[href], button")].filter(
      (el) => el.tabIndex >= 0,
    );
    expect(focusable.map((el) => el.getAttribute("data-testid"))).toEqual([
      "palette-input",
      "palette-see-all",
      "palette-close",
    ]);
  });
});

describe("IME composition", () => {
  it("does not search or act on keys until composition ends", async () => {
    renderPalette();
    await openByShortcut();
    fireEvent.compositionStart(input());
    type("こ");
    type("こん");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((input() as HTMLInputElement).value).toBe("こん");
    // Enter and arrows during composition belong to the IME
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(nav.push).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(answer([hit(1)]));
    fireEvent.compositionEnd(input());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/search?q=${encodeURIComponent("こん")}&limit=8`,
    );
  });
});

describe("with the header trigger", () => {
  it("opens from a click on the link, and Escape returns focus to it", async () => {
    render(
      <>
        <PaletteTrigger />
        <CommandPalette />
      </>,
    );
    const trigger = screen.getByTestId("palette-trigger") as HTMLAnchorElement;
    expect(trigger.getAttribute("href")).toBe("/search");
    expect(clickTakenOver(trigger)).toBe(true);
    await screen.findByRole("dialog");
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger even when the browser did not focus it on click", async () => {
    render(
      <>
        <PaletteTrigger />
        <CommandPalette />
      </>,
    );
    const trigger = screen.getByTestId("palette-trigger");
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves modified clicks to the browser (new tab)", () => {
    render(
      <>
        <PaletteTrigger />
        <CommandPalette />
      </>,
    );
    const trigger = screen.getByTestId("palette-trigger");
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(clickTakenOver(trigger, init)).toBe(false);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be opened from code (store) before any key press", async () => {
    renderPalette();
    act(() => openPalette());
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
