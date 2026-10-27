// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocNavBar } from "./doc-nav-bar";
import { DocNavPanel } from "./doc-nav-panel";
import { DocReader } from "./doc-reader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/acme/api/docs/guides/setup";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

type Listener = () => void;
let small = true;
const listeners = new Set<Listener>();

beforeEach(() => {
  pathname = "/acme/api/docs/guides/setup";
  small = true;
  listeners.clear();
  (window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
    get matches() {
      return small;
    },
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  });
});

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
  document.documentElement.removeAttribute("style");
});

function resize(toSmall: boolean) {
  small = toSmall;
  act(() => {
    for (const l of listeners) l();
  });
}

function Page({ hidden = false }: { hidden?: boolean }) {
  return (
    <DocReader>
      <DocNavBar hasOutline>
        <span>menu</span>
      </DocNavBar>
      <a href="#page-link">page link</a>
      <DocNavPanel>
        <nav aria-label="Documentation">
          <Link href="/acme/api/docs/guides/setup?type=Concept">Filter chip</Link>
          <div data-testid="docs-tree">
            <Link href="/acme/api/docs/guides/setup">Setup</Link>
            <ul hidden={hidden}>
              <li>
                <Link href="/acme/api/docs/guides/folded">Folded</Link>
              </li>
            </ul>
          </div>
        </nav>
      </DocNavPanel>
    </DocReader>
  );
}

const toggle = () => screen.getByTestId("doc-nav-toggle");
const wrap = () => screen.getByTestId("doc-nav-wrap");
const sheet = () => screen.getByTestId("doc-nav");
const close = () => screen.getByTestId("doc-nav-close");
const open = () => fireEvent.click(toggle());

describe("DocNavPanel below lg", () => {
  it("is a closed dialog-to-be: the toggle states it and the panel is not marked open", () => {
    render(<Page />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe(sheet().id);
    expect(wrap().dataset.open).toBe("false");
  });

  it("opens as a named modal dialog with focus on its first control", () => {
    render(<Page />);
    open();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(wrap().dataset.open).toBe("true");
    expect(sheet().getAttribute("role")).toBe("dialog");
    expect(sheet().getAttribute("aria-modal")).toBe("true");
    expect(sheet().getAttribute("aria-label")).toBe("Documentation menu");
    expect(document.activeElement).toBe(close());
  });

  it("locks page scroll while open and restores it on close", () => {
    document.documentElement.style.overflow = "scroll";
    render(<Page />);
    open();
    expect(document.documentElement.style.overflow).toBe("hidden");
    fireEvent.click(close());
    expect(document.documentElement.style.overflow).toBe("scroll");
  });

  it("closes on Esc and returns focus to the toggle", () => {
    render(<Page />);
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(wrap().dataset.open).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("closes from the backdrop and from the close button, focus back on the toggle", () => {
    const { container } = render(<Page />);
    open();
    fireEvent.click(container.querySelector(".doc-panel__backdrop") as HTMLElement);
    expect(wrap().dataset.open).toBe("false");
    expect(document.activeElement).toBe(toggle());
    open();
    fireEvent.click(close());
    expect(wrap().dataset.open).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("wraps Tab and Shift+Tab inside the panel and skips controls in hidden folders", () => {
    render(<Page hidden />);
    open();
    const last = screen.getByRole("link", { name: "Setup" });
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close());
    const back = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(back);
    expect(document.activeElement).toBe(last);
  });

  it("pulls focus back in when it is on the page behind", () => {
    render(<Page />);
    open();
    screen.getByText("page link").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(document.activeElement).toBe(close());
  });

  it("closes when a document link is chosen, including the page that is already open", () => {
    render(<Page />);
    open();
    fireEvent.click(screen.getByRole("link", { name: "Setup" }));
    expect(wrap().dataset.open).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("stays open when a filter chip is chosen", () => {
    render(<Page />);
    open();
    fireEvent.click(screen.getByRole("link", { name: "Filter chip" }));
    expect(wrap().dataset.open).toBe("true");
  });

  it("closes when the pathname changes (a document was chosen)", () => {
    const { rerender } = render(<Page />);
    open();
    pathname = "/acme/api/docs/guides/other";
    rerender(<Page />);
    expect(wrap().dataset.open).toBe("false");
  });

  it("stays open when only the search string changes (a filter chip)", () => {
    const { rerender } = render(<Page />);
    open();
    // usePathname has no search string: a chip click re-renders with the same pathname
    rerender(<Page />);
    expect(wrap().dataset.open).toBe("true");
  });

  it("closes when the viewport grows to lg or wider", () => {
    render(<Page />);
    open();
    resize(false);
    expect(wrap().dataset.open).toBe("false");
    expect(document.documentElement.style.overflow).toBe("");
  });
});

describe("DocNavPanel from lg", () => {
  it("is a plain column: no dialog semantics, and never marked open", () => {
    small = false;
    render(<Page />);
    expect(sheet().getAttribute("role")).toBeNull();
    expect(sheet().getAttribute("aria-modal")).toBeNull();
    fireEvent.click(toggle());
    expect(wrap().dataset.open).toBe("false");
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("keeps its tree markup when the viewport changes", () => {
    render(<Page />);
    const link = screen.getByRole("link", { name: "Setup" });
    resize(false);
    expect(screen.getByRole("link", { name: "Setup" })).toBe(link);
  });
});
