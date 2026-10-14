// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildOutline } from "@/lib/outline";

import { OutlineNav } from "./outline-nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items = buildOutline(
  [
    { depth: 2, text: "Install", slug: "install" },
    { depth: 3, text: "Linux", slug: "linux" },
    { depth: 2, text: "Use", slug: "use" },
  ],
  (s) => s,
);

/** Observers created by the component, so a test can fire them. */
let observers: { callback: () => void; observed: Element[]; disconnected: boolean }[] = [];

class FakeObserver {
  private record: { callback: () => void; observed: Element[]; disconnected: boolean };
  constructor(callback: () => void) {
    this.record = { callback, observed: [], disconnected: false };
    observers.push(this.record);
  }
  observe(el: Element) {
    this.record.observed.push(el);
  }
  disconnect() {
    this.record.disconnected = true;
  }
}

/** Puts headings in the document at the given tops (px). */
function headings(tops: Record<string, number>) {
  for (const [id, top] of Object.entries(tops)) {
    const el = document.createElement("h2");
    el.id = id;
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
    document.body.appendChild(el);
  }
}

beforeEach(() => {
  observers = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

const current = () => document.querySelector('[aria-current="location"]')?.textContent ?? null;

describe("OutlineNav", () => {
  it("is the 'On this page' navigation with nested links to the heading ids", () => {
    render(<OutlineNav items={items} />);
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([
      ["Install", "#install"],
      ["Linux", "#linux"],
      ["Use", "#use"],
    ]);
    // Linux is nested under Install
    const install = within(nav).getByRole("link", { name: "Install" }).closest("li");
    expect(within(install as HTMLElement).getByRole("link", { name: "Linux" })).toBeTruthy();
    expect(within(nav).getByText("On this page")).toBeTruthy();
  });

  it("renders nothing for an empty outline", () => {
    const { container } = render(<OutlineNav items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("escapes heading text", () => {
    const hostile = buildOutline(
      [{ depth: 2, text: "<img src=x onerror=alert(1)>", slug: "x" }],
      (s) => s,
    );
    render(<OutlineNav items={hostile} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("marks the last heading above the line as the current section", async () => {
    // line = 15% of 1000 = 150px
    headings({ install: -400, linux: 100, use: 700 });
    await act(async () => {
      render(<OutlineNav items={items} />);
    });
    expect(current()).toBe("Linux");
    expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
  });

  it("has no current section before the first heading", async () => {
    headings({ install: 400, linux: 600, use: 800 });
    await act(async () => {
      render(<OutlineNav items={items} />);
    });
    expect(current()).toBeNull();
  });

  it("follows the reader when a heading crosses the line", async () => {
    headings({ install: 100, linux: 600, use: 900 });
    await act(async () => {
      render(<OutlineNav items={items} />);
    });
    expect(current()).toBe("Install");
    // the reader scrolls: Use moves above the line
    for (const [id, top] of Object.entries({ install: -800, linux: -300, use: 120 })) {
      (document.getElementById(id) as HTMLElement).getBoundingClientRect = () =>
        ({ top }) as DOMRect;
    }
    await act(async () => {
      for (const o of observers) o.callback();
    });
    expect(current()).toBe("Use");
  });

  it("observes every heading and disconnects on unmount", async () => {
    headings({ install: 100, linux: 600, use: 900 });
    let unmount = () => {};
    await act(async () => {
      unmount = render(<OutlineNav items={items} />).unmount;
    });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed.map((e) => e.id)).toEqual(["install", "linux", "use"]);
    unmount();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it("marks a clicked entry at once", async () => {
    headings({ install: 100, linux: 600, use: 900 });
    await act(async () => {
      render(<OutlineNav items={items} />);
    });
    fireEvent.click(screen.getByRole("link", { name: "Use" }));
    expect(current()).toBe("Use");
  });

  it("still lists the links when IntersectionObserver is missing", async () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    headings({ install: 100, linux: 600, use: 900 });
    await act(async () => {
      render(<OutlineNav items={items} />);
    });
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(current()).toBe("Install");
  });
});

describe("OutlineNav menu variant", () => {
  const button = () => screen.getByRole("button", { name: "On this page" });
  const list = () => screen.getByTestId("outline-menu-list");

  it("is a closed button that states and toggles whether the list is open", () => {
    render(<OutlineNav items={items} variant="menu" />);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-controls")).toBe(list().id);
    expect(list().hidden).toBe(true);
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(list().hidden).toBe(false);
    fireEvent.click(button());
    expect(list().hidden).toBe(true);
  });

  it("lists the headings as nested links to their ids", () => {
    render(<OutlineNav items={items} variant="menu" />);
    fireEvent.click(button());
    expect(
      within(list())
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([
      ["Install", "#install"],
      ["Linux", "#linux"],
      ["Use", "#use"],
    ]);
  });

  it("marks the current section", async () => {
    headings({ install: -400, linux: 100, use: 700 });
    await act(async () => {
      render(<OutlineNav items={items} variant="menu" />);
    });
    fireEvent.click(button());
    expect(current()).toBe("Linux");
  });

  it("closes when a heading is chosen and marks it at once", () => {
    render(<OutlineNav items={items} variant="menu" />);
    fireEvent.click(button());
    fireEvent.click(within(list()).getByRole("link", { name: "Use" }));
    expect(list().hidden).toBe(true);
    fireEvent.click(button());
    expect(current()).toBe("Use");
  });

  it("leaves the jump to the browser, so the page's scroll padding clears the header and bar", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<OutlineNav items={items} variant="menu" />);
    fireEvent.click(button());
    const link = within(list()).getByRole("link", { name: "Use" });
    expect(link.getAttribute("href")).toBe("#use");
    fireEvent.click(link);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollTo.mockRestore();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("closes on Esc and puts focus back on the button", () => {
    render(<OutlineNav items={items} variant="menu" />);
    fireEvent.click(button());
    within(list()).getByRole("link", { name: "Linux" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(list().hidden).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it("closes on a press outside, not on a press inside", () => {
    render(<OutlineNav items={items} variant="menu" />);
    fireEvent.click(button());
    fireEvent.pointerDown(list());
    expect(list().hidden).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(list().hidden).toBe(true);
  });

  it("closes when focus moves out of it", () => {
    render(
      <>
        <OutlineNav items={items} variant="menu" />
        <a href="#elsewhere">elsewhere</a>
      </>,
    );
    fireEvent.click(button());
    const link = within(list()).getByRole("link", { name: "Use" });
    link.focus();
    fireEvent.blur(link, { relatedTarget: screen.getByText("elsewhere") });
    expect(list().hidden).toBe(true);
  });

  it("scrolls inside itself when long", () => {
    render(<OutlineNav items={items} variant="menu" />);
    expect(list().className).toContain("max-h-[60vh]");
    expect(list().className).toContain("overflow-y-auto");
  });

  it("renders nothing for an empty outline, in either variant", () => {
    expect(render(<OutlineNav items={[]} variant="menu" />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<OutlineNav items={[]} variant="column" />).container.innerHTML).toBe("");
  });

  it("leaves the column variant as the plain list with its own landmark", () => {
    render(<OutlineNav items={items} />);
    expect(screen.getByTestId("outline")).toBeTruthy();
    expect(screen.queryByTestId("outline-menu")).toBeNull();
  });
});
