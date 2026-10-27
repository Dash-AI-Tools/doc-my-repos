import { describe, expect, it } from "vitest";

import { parseBrandColor, parseOrgName, parsePageTitle } from "./validate";

describe("parseOrgName", () => {
  it("accepts valid values", () => {
    expect(parseOrgName("Acme")).toEqual({ ok: true, value: "Acme" });
    expect(parseOrgName("a".repeat(60))).toEqual({ ok: true, value: "a".repeat(60) });
  });

  it("trims and clears on empty", () => {
    expect(parseOrgName("  Acme  ")).toEqual({ ok: true, value: "Acme" });
    expect(parseOrgName("")).toEqual({ ok: true, value: null });
    expect(parseOrgName(null)).toEqual({ ok: true, value: null });
  });

  it("rejects each bad shape", () => {
    expect(parseOrgName("a".repeat(61)).ok).toBe(false);
    expect(parseOrgName("a\n b").ok).toBe(false);
    expect(parseOrgName("a\u0000b").ok).toBe(false);
    expect(parseOrgName("a\u202Eb").ok).toBe(false);
    expect(parseOrgName(42).ok).toBe(false);
  });

  it("accepts markup-looking text as text", () => {
    expect(parseOrgName("<b>Acme</b>")).toEqual({ ok: true, value: "<b>Acme</b>" });
  });
});

describe("parsePageTitle", () => {
  it("accepts up to 70 chars and clears on empty", () => {
    expect(parsePageTitle("Acme Docs")).toEqual({ ok: true, value: "Acme Docs" });
    const seventy = "t".repeat(70);
    expect(parsePageTitle(seventy)).toEqual({ ok: true, value: seventy });
    expect(parsePageTitle("  ")).toEqual({ ok: true, value: null });
  });

  it("rejects too-long and control text", () => {
    expect(parsePageTitle("t".repeat(71)).ok).toBe(false);
    expect(parsePageTitle("a\u0008b").ok).toBe(false);
  });
});

describe("parseBrandColor", () => {
  it("accepts valid values and lower-cases", () => {
    expect(parseBrandColor("#2b59ff")).toEqual({ ok: true, value: "#2b59ff" });
    expect(parseBrandColor("#2B59FF")).toEqual({ ok: true, value: "#2b59ff" });
    expect(parseBrandColor("  #ffffff  ")).toEqual({ ok: true, value: "#ffffff" });
  });

  it("clears on empty", () => {
    expect(parseBrandColor("")).toEqual({ ok: true, value: null });
    expect(parseBrandColor(null)).toEqual({ ok: true, value: null });
  });

  it("rejects style-injection strings and malformed colors", () => {
    const bad: unknown[] = [
      "#fff",
      "red",
      "#gggggg",
      "#2b59ffcc",
      "#fff;} body{display:none",
      "expression(alert(1))",
      42,
    ];
    for (const value of bad) {
      expect(parseBrandColor(value).ok, String(value)).toBe(false);
    }
  });
});
