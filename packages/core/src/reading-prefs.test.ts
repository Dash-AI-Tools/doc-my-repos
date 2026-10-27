import { describe, expect, it } from "vitest";

import {
  DEFAULT_NAV_VIEW,
  NAV_VIEW_COOKIE,
  parseNavView,
  DEFAULT_READ_KEY,
  DEFAULT_TEXT_SIZE,
  READ_KEY_COOKIE,
  TEXT_SIZE_COOKIE,
  TEXT_SIZE_STEPS,
  isReadShortcut,
  parseReadKey,
  parseTextSize,
  serializePreference,
  type ShortcutContext,
  type ShortcutKeyEvent,
  type ShortcutTarget,
  textSizeStep,
} from "./reading-prefs";

describe("text size steps", () => {
  it("lists the five steps in order with their percent and scale", () => {
    expect(TEXT_SIZE_STEPS.map((step) => [step.id, step.label, step.percent, step.scale])).toEqual([
      ["small", "Small", 87.5, 0.875],
      ["default", "Default", 100, 1],
      ["large", "Large", 112.5, 1.125],
      ["larger", "Larger", 125, 1.25],
      ["largest", "Largest", 150, 1.5],
    ]);
  });

  it("keeps the scale equal to the percent", () => {
    for (const step of TEXT_SIZE_STEPS) {
      expect(step.scale * 100).toBeCloseTo(step.percent);
    }
  });

  it("finds a step by id", () => {
    expect(textSizeStep("larger").percent).toBe(125);
  });
});

describe("parseTextSize", () => {
  it.each(["small", "default", "large", "larger", "largest"])("accepts %s", (value) => {
    expect(parseTextSize(value)).toBe(value);
  });

  it.each([
    ["garbage", "huge"],
    ["empty", ""],
    ["different case", "Large"],
    ["surrounding space", " large "],
    ["array-like", ["large"]],
    ["object", { 0: "large", length: 1 }],
    ["overlong", "x".repeat(10_000)],
    ["number", 3],
    ["missing", undefined],
    ["null", null],
  ])("maps %s to the default", (_label, value) => {
    expect(parseTextSize(value)).toBe(DEFAULT_TEXT_SIZE);
  });
});

describe("parseReadKey", () => {
  it("is off only for the exact value off", () => {
    expect(parseReadKey("off")).toBe("off");
  });

  it.each([
    ["on", "on"],
    ["garbage", "garbage"],
    ["empty", ""],
    ["array-like", ["off"]],
    ["object", { 0: "off", length: 1 }],
    ["overlong", "off".repeat(5_000)],
    ["missing", undefined],
  ])("maps %s to the default (on)", (_label, value) => {
    expect(parseReadKey(value)).toBe(DEFAULT_READ_KEY);
  });
});

describe("parseNavView", () => {
  it("is tree only for the exact value tree", () => {
    expect(parseNavView("tree")).toBe("tree");
  });

  it.each([
    ["okf", "okf"],
    ["other case", "Tree"],
    ["padded", " tree"],
    ["garbage", "garbage"],
    ["empty", ""],
    ["array-like", ["tree"]],
    ["object", { 0: "tree", length: 1 }],
    ["overlong", "tree".repeat(5_000)],
    ["missing", undefined],
  ])("maps %s to the default (okf)", (_label, value) => {
    expect(parseNavView(value)).toBe(DEFAULT_NAV_VIEW);
    expect(DEFAULT_NAV_VIEW).toBe("okf");
  });

  it("has the documented cookie name", () => {
    expect(NAV_VIEW_COOKIE).toBe("docmyrepos-nav-view");
  });
});

describe("cookie names", () => {
  it("are the documented names", () => {
    expect(TEXT_SIZE_COOKIE).toBe("docmyrepos-text-size");
    expect(READ_KEY_COOKIE).toBe("docmyrepos-read-key");
  });
});

describe("serializePreference", () => {
  it("writes a value with a one year, site-wide, same-site cookie", () => {
    expect(serializePreference(TEXT_SIZE_COOKIE, "large", { secure: false })).toBe(
      "docmyrepos-text-size=large; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("adds Secure only when the page is served over https", () => {
    expect(serializePreference(READ_KEY_COOKIE, "off", { secure: true })).toBe(
      "docmyrepos-read-key=off; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });

  it("expires the cookie for a null value", () => {
    expect(serializePreference(TEXT_SIZE_COOKIE, null, { secure: false })).toBe(
      "docmyrepos-text-size=; Path=/; Max-Age=0; SameSite=Lax",
    );
  });

  it("keeps Secure on a clear over https", () => {
    expect(serializePreference(READ_KEY_COOKIE, null, { secure: true })).toBe(
      "docmyrepos-read-key=; Path=/; Max-Age=0; SameSite=Lax; Secure",
    );
  });
});

describe("isReadShortcut", () => {
  const press = (overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
    key: "r",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    ...overrides,
  });
  const onPage: ShortcutContext = { enabled: true, available: true, overlayOpen: false };
  const element = (overrides: Partial<ShortcutTarget> = {}): ShortcutTarget => ({
    tagName: "DIV",
    isContentEditable: false,
    role: null,
    ...overrides,
  });

  it("accepts r and R, with or without Shift", () => {
    expect(isReadShortcut(press({ key: "r" }), null, onPage)).toBe(true);
    expect(isReadShortcut(press({ key: "R" }), null, onPage)).toBe(true);
  });

  it("accepts a press aimed at the page body or any non-text element", () => {
    expect(isReadShortcut(press(), element({ tagName: "ARTICLE" }), onPage)).toBe(true);
    expect(isReadShortcut(press(), element({ tagName: "BUTTON", role: "button" }), onPage)).toBe(
      true,
    );
  });

  it.each([
    ["another letter", { key: "s" }],
    ["Enter", { key: "Enter" }],
    ["Ctrl held", { ctrlKey: true }],
    ["Cmd held", { metaKey: true }],
    ["Alt held", { altKey: true }],
    ["composing text", { isComposing: true }],
    ["a held key repeat", { repeat: true }],
  ])("rejects %s", (_label, overrides) => {
    expect(isReadShortcut(press(overrides), null, onPage)).toBe(false);
  });

  it.each([
    ["a text input", element({ tagName: "INPUT", role: "textbox" })],
    ["a text area", element({ tagName: "TEXTAREA" })],
    ["a select", element({ tagName: "SELECT" })],
    ["an editable region", element({ tagName: "DIV", isContentEditable: true })],
    ["a textbox role", element({ tagName: "DIV", role: "textbox" })],
    ["a combobox role", element({ tagName: "DIV", role: "combobox" })],
    ["a searchbox role", element({ tagName: "DIV", role: "searchbox" })],
  ])("rejects a press aimed at %s", (_label, target) => {
    expect(isReadShortcut(press(), target, onPage)).toBe(false);
  });

  it("rejects when the shortcut setting is off", () => {
    expect(isReadShortcut(press(), null, { ...onPage, enabled: false })).toBe(false);
  });

  it("rejects when read mode is not available on this page", () => {
    expect(isReadShortcut(press(), null, { ...onPage, available: false })).toBe(false);
  });

  it("rejects while an overlay is open", () => {
    expect(isReadShortcut(press(), null, { ...onPage, overlayOpen: true })).toBe(false);
  });
});
