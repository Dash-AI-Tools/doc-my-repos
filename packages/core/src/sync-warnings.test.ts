import { describe, expect, it } from "vitest";

import { MAX_SYNC_WARNINGS, parseSyncWarnings, skippedFileCount } from "./sync-warnings";

describe("parseSyncWarnings", () => {
  it("keeps well-formed entries and drops malformed ones", () => {
    expect(
      parseSyncWarnings([
        { code: "too_large", message: "1 file", count: 1, paths: ["docs/a.md", 5, ""] },
        { code: "docs_capped", message: "m", count: 3 },
        { code: "", message: "m", count: 1 },
        { code: "x", message: 1, count: 1 },
        { code: "x", message: "m", count: -1 },
        { code: "x", message: "m", count: 1.5 },
        null,
        "text",
        [1],
      ]),
    ).toEqual([
      { code: "too_large", message: "1 file", count: 1, paths: ["docs/a.md"] },
      { code: "docs_capped", message: "m", count: 3, paths: [] },
    ]);
  });

  it("is empty for anything but an array", () => {
    for (const value of [null, undefined, {}, "x", 5]) expect(parseSyncWarnings(value)).toEqual([]);
  });

  it("bounds the list, the paths and the text", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      code: `c${i}`,
      message: "m".repeat(5000),
      count: 1,
      paths: Array.from({ length: 100 }, (_, j) => `p${j}`),
    }));
    const parsed = parseSyncWarnings(many);
    expect(parsed).toHaveLength(MAX_SYNC_WARNINGS);
    expect(parsed[0]?.paths).toHaveLength(20);
    expect(parsed[0]?.message.length).toBe(500);
    expect(skippedFileCount(parsed)).toBe(MAX_SYNC_WARNINGS);
  });
});
