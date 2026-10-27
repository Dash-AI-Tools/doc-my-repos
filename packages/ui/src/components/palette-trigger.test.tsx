// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { PaletteTrigger, shortcutLabel } from "./palette-trigger";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "platform");
  if (original !== undefined) Object.defineProperty(Navigator.prototype, "platform", original);
});

describe("PaletteTrigger", () => {
  it("is a link to /search that announces the shortcut and the dialog", () => {
    render(<PaletteTrigger />);
    const link = screen.getByRole("link", { name: "Search" });
    expect(link.getAttribute("href")).toBe("/search");
    expect(link.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    expect(link.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("renders `Ctrl K` on the server, so markup never depends on the platform", () => {
    setPlatform("MacIntel");
    const html = renderToStaticMarkup(<PaletteTrigger />);
    expect(html).toContain("Ctrl K");
    expect(html).not.toContain("⌘");
  });

  it("swaps to the Command symbol on Apple platforms after mount", async () => {
    setPlatform("MacIntel");
    render(<PaletteTrigger />);
    expect(screen.getByTestId("palette-shortcut").textContent).toBe("⌘K");
  });

  it.each(["iPhone", "iPad", "Macintosh"])("also on %s", (platform) => {
    setPlatform(platform);
    render(<PaletteTrigger />);
    expect(screen.getByTestId("palette-shortcut").textContent).toBe("⌘K");
  });

  it.each(["Win32", "Linux x86_64", ""])("keeps `Ctrl K` on %j", (platform) => {
    setPlatform(platform);
    render(<PaletteTrigger />);
    expect(screen.getByTestId("palette-shortcut").textContent).toBe("Ctrl K");
  });

  it("hides the hint chip from assistive technology (the shortcut is in aria-keyshortcuts)", () => {
    render(<PaletteTrigger />);
    expect(screen.getByTestId("palette-shortcut").getAttribute("aria-hidden")).toBe("true");
    expect(shortcutLabel(true)).toBe("⌘K");
    expect(shortcutLabel(false)).toBe("Ctrl K");
  });
});
