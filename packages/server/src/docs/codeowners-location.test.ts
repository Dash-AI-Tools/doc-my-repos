import { describe, expect, it } from "vitest";
import { pickCodeownersPath } from "./codeowners-location";

const GH = ".github/CODEOWNERS";
const ROOT = "CODEOWNERS";
const DOCS = "docs/CODEOWNERS";

describe("pickCodeownersPath", () => {
  it.each([GH, ROOT, DOCS])("picks %s when alone", (p) => {
    expect(pickCodeownersPath(["README.md", p, "src/a.ts"])).toBe(p);
  });

  it("prefers .github over root and docs", () => {
    expect(pickCodeownersPath([DOCS, ROOT, GH])).toBe(GH);
  });

  it("handles every pair", () => {
    expect(pickCodeownersPath([ROOT, GH])).toBe(GH);
    expect(pickCodeownersPath([DOCS, GH])).toBe(GH);
    expect(pickCodeownersPath([DOCS, ROOT])).toBe(ROOT);
  });

  it("returns null when none, empty, or odd input", () => {
    expect(pickCodeownersPath(["README.md"])).toBeNull();
    expect(pickCodeownersPath([])).toBeNull();
    expect(pickCodeownersPath(null)).toBeNull();
    expect(pickCodeownersPath(undefined)).toBeNull();
    expect(pickCodeownersPath(5 as unknown as string[])).toBeNull();
    expect(pickCodeownersPath([null, 1, {}, { path: 3 }] as unknown as string[])).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(pickCodeownersPath(["codeowners", ".github/codeowners", "Docs/CODEOWNERS"])).toBeNull();
    expect(pickCodeownersPath([".GitHub/CODEOWNERS", ROOT])).toBe(ROOT);
  });

  it("ignores nested locations", () => {
    expect(pickCodeownersPath(["src/.github/CODEOWNERS", "src/CODEOWNERS"])).toBeNull();
    expect(pickCodeownersPath(["src/.github/CODEOWNERS", DOCS])).toBe(DOCS);
  });

  it("ignores non-blob entries", () => {
    expect(
      pickCodeownersPath([
        { path: GH, type: "tree" },
        { path: ROOT, type: "commit" },
        { path: DOCS, type: "blob" },
      ]),
    ).toBe(DOCS);
    expect(pickCodeownersPath([{ path: ROOT, type: "tree" }])).toBeNull();
  });

  it("accepts blob entries and iterables", () => {
    expect(pickCodeownersPath(new Set([{ path: ROOT, type: "blob" }]))).toBe(ROOT);
  });
});
