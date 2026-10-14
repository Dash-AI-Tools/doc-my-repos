// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocNavBar } from "./doc-nav-bar";
import { DocNavPanel } from "./doc-nav-panel";
import { DocReader } from "./doc-reader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/api/docs/setup" }));

beforeEach(() => {
  (window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 44,
  });
});

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
  delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
  document.documentElement.removeAttribute("style");
});

const page = (hasOutline: boolean) => (
  <DocReader>
    <DocNavBar hasOutline={hasOutline}>
      <span data-testid="menu-slot">menu</span>
    </DocNavBar>
    <DocNavPanel>
      <Link href="/x">x</Link>
    </DocNavPanel>
  </DocReader>
);

describe("DocNavBar", () => {
  it("is invisible (keeping its height) before scripts run, and the page is not enhanced", () => {
    const html = renderToString(page(true));
    expect(html).toContain('data-enhanced="false"');
    const bar = html.match(/<div[^>]*data-testid="doc-bar"[^>]*>/)?.[0] ?? "";
    expect(bar).toContain("invisible");
  });

  it("is shown once enhanced", () => {
    render(page(true));
    expect(screen.getByTestId("doc-bar").className).not.toContain("invisible");
    expect(document.querySelector(".doc-reader")?.getAttribute("data-enhanced")).toBe("true");
  });

  it("holds the hamburger and the headings slot, hidden from xl when there are headings", () => {
    render(page(true));
    const bar = screen.getByTestId("doc-bar");
    expect(bar.className).toContain("xl:hidden");
    expect(screen.getByTestId("doc-nav-toggle").className).toContain("lg:hidden");
    expect(screen.getByTestId("menu-slot")).toBeTruthy();
  });

  it("with no headings holds only the hamburger and is hidden from lg", () => {
    render(
      <DocReader>
        <DocNavBar hasOutline={false} />
      </DocReader>,
    );
    expect(screen.getByTestId("doc-bar").className).toContain("lg:hidden");
    expect(screen.queryByTestId("menu-slot")).toBeNull();
  });

  it("toggles the panel with the hamburger, which states it", () => {
    render(page(true));
    const toggle = screen.getByTestId("doc-nav-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("doc-nav-wrap").dataset.open).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("doc-nav-wrap").dataset.open).toBe("false");
  });

  it("publishes its height as --doc-bar-h and clears it when it goes away", () => {
    const { unmount } = render(page(true));
    expect(document.documentElement.style.getPropertyValue("--doc-bar-h")).toBe("44px");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--doc-bar-h")).toBe("");
  });
});
