import { describe, expect, it } from "vitest";

import { HIGHLIGHT_END, HIGHLIGHT_START, MAX_QUERY_CHARS, normalizeSearchQuery } from "./search";

describe("normalizeSearchQuery", () => {
  it("collapses whitespace, trims, and keeps websearch operators", () => {
    expect(normalizeSearchQuery("  rate \t\n limit  ")).toBe("rate limit");
    expect(normalizeSearchQuery('"exact phrase" -draft or other')).toBe(
      '"exact phrase" -draft or other',
    );
  });

  it("returns the empty query for anything that is not a string", () => {
    for (const value of [undefined, null, 5, {}, ["a"]])
      expect(normalizeSearchQuery(value)).toBe("");
  });

  it("turns control characters and NUL into spaces", () => {
    expect(normalizeSearchQuery("a\u0000b\u0007c\u007fd\u0085e")).toBe("a b c d e");
  });

  it("turns lone surrogates into spaces and keeps valid pairs", () => {
    expect(normalizeSearchQuery("a\ud800b")).toBe("a b");
    expect(normalizeSearchQuery("a\udc00b")).toBe("a b");
    expect(normalizeSearchQuery("🦄 unicorn")).toBe("🦄 unicorn");
  });

  it("strips the highlight markers, so a query cannot forge a highlight", () => {
    expect(normalizeSearchQuery(`${HIGHLIGHT_START}rate${HIGHLIGHT_END} limit`)).toBe("rate limit");
    expect(normalizeSearchQuery(`ra${HIGHLIGHT_START}te`)).toBe("ra te");
    expect(normalizeSearchQuery(`${HIGHLIGHT_START}${HIGHLIGHT_END}`)).toBe("");
    const out = normalizeSearchQuery(`x${HIGHLIGHT_START}y${HIGHLIGHT_END}z`);
    expect(out.includes(HIGHLIGHT_START)).toBe(false);
    expect(out.includes(HIGHLIGHT_END)).toBe(false);
  });

  it("cuts to MAX_QUERY_CHARS code points without splitting a surrogate pair", () => {
    const out = normalizeSearchQuery("🦄".repeat(MAX_QUERY_CHARS + 10));
    expect(Array.from(out)).toHaveLength(MAX_QUERY_CHARS);
    expect(out).toBe("🦄".repeat(MAX_QUERY_CHARS));
  });
});
