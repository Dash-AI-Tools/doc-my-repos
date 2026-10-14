// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_STORAGE_KEY, ThemeProvider } from "./theme-provider";
import { ThemeToggle } from "./theme-toggle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Query {
  matches: boolean;
  listeners: Set<(event: { matches: boolean }) => void>;
}

let query: Query;

/** matchMedia stub whose "dark" answer the test controls. */
function stubMatchMedia(dark: boolean): void {
  query = { matches: dark, listeners: new Set() };
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return query.matches;
    },
    addListener: (fn: (event: { matches: boolean }) => void) => query.listeners.add(fn),
    removeListener: (fn: (event: { matches: boolean }) => void) => query.listeners.delete(fn),
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) =>
      query.listeners.add(fn),
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) =>
      query.listeners.delete(fn),
  }));
}

function setSystemDark(dark: boolean): void {
  query.matches = dark;
  act(() => {
    for (const fn of query.listeners) fn({ matches: dark });
  });
}

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("renders a labelled radio group with Light, Dark and System", () => {
    renderToggle();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label"))).toEqual([
      "Light",
      "Dark",
      "System",
    ]);
  });

  it("selects System by default and only System", () => {
    renderToggle();
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    expect(radio("Light").getAttribute("aria-checked")).toBe("false");
    expect(radio("Dark").getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("shows the stored choice, not the resolved theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    stubMatchMedia(true);
    renderToggle();
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");
    expect(radio("System").getAttribute("aria-checked")).toBe("false");
  });

  it("keeps System selected while the OS preference makes the page dark", () => {
    stubMatchMedia(true);
    renderToggle();
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("clicking applies the class immediately and persists under the storage key", () => {
    renderToggle();
    fireEvent.click(radio("Dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(radio("Light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("System follows the OS preference live", () => {
    stubMatchMedia(true);
    renderToggle();
    fireEvent.click(radio("Light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    fireEvent.click(radio("System"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    setSystemDark(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    setSystemDark(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("uses a roving tabindex: only the selected option is a tab stop", () => {
    renderToggle();
    expect(radio("System").tabIndex).toBe(0);
    expect(radio("Light").tabIndex).toBe(-1);
    fireEvent.click(radio("Dark"));
    expect(radio("Dark").tabIndex).toBe(0);
    expect(radio("System").tabIndex).toBe(-1);
  });

  it("moves and selects with the arrow keys, wrapping at the ends", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderToggle();
    radio("Light").focus();

    fireEvent.keyDown(radio("Light"), { key: "ArrowRight" });
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("Dark"));

    fireEvent.keyDown(radio("Dark"), { key: "ArrowDown" });
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("System"));

    fireEvent.keyDown(radio("System"), { key: "ArrowRight" });
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radio("Light"), { key: "ArrowLeft" });
    expect(radio("System").getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radio("System"), { key: "ArrowUp" });
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("jumps with Home and End and ignores other keys", () => {
    renderToggle();
    fireEvent.keyDown(radio("System"), { key: "Home" });
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("Light"), { key: "End" });
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("System"), { key: "a" });
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("falls back to System for an unknown stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    renderToggle();
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
  });

  it("works without a provider (inert context) and keeps System selected", () => {
    render(<ThemeToggle />);
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("hides the icons from assistive technology", () => {
    const { container } = renderToggle();
    const icons = container.querySelectorAll("svg");
    expect(icons.length).toBe(3);
    for (const icon of icons) expect(icon.getAttribute("aria-hidden")).toBe("true");
  });
});
