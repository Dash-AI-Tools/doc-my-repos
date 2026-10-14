import { describe, expect, it } from "vitest";
import { findDocsFolder, normalizeDocsPath } from "./docs-folder";

describe("findDocsFolder defaults", () => {
  it.each(["docs", "doc", "documentation"])("finds %s", (name) => {
    expect(findDocsFolder(["README.md", `${name}/a.md`, "src/x.ts"])).toBe(name);
  });

  it.each([
    ["Docs", "Docs/a.md"],
    ["DOC", "DOC/a.md"],
    ["Documentation", "Documentation/guide/b.md"],
  ])("matches case-insensitively and keeps case: %s", (expected, file) => {
    expect(findDocsFolder([file])).toBe(expected);
  });

  it("follows candidate order: docs beats doc beats documentation", () => {
    expect(findDocsFolder(["documentation/a.md", "doc/a.md", "docs/a.md"])).toBe("docs");
    expect(findDocsFolder(["documentation/a.md", "doc/a.md"])).toBe("doc");
  });

  it("uses a custom candidate list in its order", () => {
    const tree = ["docs/a.md", "wiki/a.md"];
    expect(findDocsFolder(tree, { defaults: ["wiki", "docs"] })).toBe("wiki");
  });

  it("prefers exact-case, then lexicographic, when directories differ only by case", () => {
    expect(findDocsFolder(["Docs/a.md", "docs/a.md", "DOCS/a.md"])).toBe("docs");
    expect(findDocsFolder(["Docs/a.md", "DOCS/a.md"])).toBe("DOCS");
  });

  it("accepts tree entries and empty directories", () => {
    expect(findDocsFolder([{ path: "Docs", type: "tree" }])).toBe("Docs");
    expect(findDocsFolder([{ path: "Docs/a.md", type: "blob" }])).toBe("Docs");
  });

  it("returns null when there are no docs", () => {
    expect(findDocsFolder(["README.md", "src/index.ts"])).toBeNull();
    expect(findDocsFolder([])).toBeNull();
  });

  it("ignores a file named docs and submodules", () => {
    expect(findDocsFolder(["docs", "README.md"])).toBeNull();
    expect(findDocsFolder([{ path: "docs", type: "blob" }])).toBeNull();
    expect(findDocsFolder([{ path: "docs", type: "commit" }])).toBeNull();
  });

  it("only counts the folder itself, not a lookalike name", () => {
    expect(findDocsFolder(["docs-old/a.md", "mydocs/a.md", "docsx"])).toBeNull();
  });

  it("does not match nested defaults under another folder", () => {
    expect(findDocsFolder(["src/docs/a.md"])).toBeNull();
  });
});

describe("findDocsFolder override", () => {
  it("wins even when docs exists", () => {
    expect(findDocsFolder(["docs/a.md", "handbook/b.md"], { docsPath: "handbook" })).toBe(
      "handbook",
    );
  });

  it("matches case-insensitively and keeps tree case", () => {
    expect(findDocsFolder(["Handbook/b.md"], { docsPath: "handbook" })).toBe("Handbook");
  });

  it("returns null when missing, with no fallback", () => {
    expect(findDocsFolder(["docs/a.md"], { docsPath: "handbook" })).toBeNull();
  });

  it("supports nested paths", () => {
    expect(findDocsFolder(["packages/X/Docs/a.md"], { docsPath: "packages/x/docs" })).toBe(
      "packages/X/Docs",
    );
  });

  it("normalizes slashes and ./", () => {
    expect(findDocsFolder(["handbook/a.md"], { docsPath: "./handbook/" })).toBe("handbook");
    expect(findDocsFolder(["a/b/c.md"], { docsPath: "a//b///" })).toBe("a/b");
  });

  it("null or undefined override means unset", () => {
    expect(findDocsFolder(["docs/a.md"], { docsPath: null })).toBe("docs");
    expect(findDocsFolder(["docs/a.md"], { docsPath: undefined })).toBe("docs");
  });

  it.each([
    "../secret",
    "a/../b",
    "..",
    "/etc",
    "/docs",
    "a\\b",
    "docs\0x",
    "",
    "  ",
    ".",
    "./",
    "//",
  ])("rejects unsafe override %j without falling back", (docsPath) => {
    expect(
      findDocsFolder(["docs/a.md", "secret/x.md", "etc/x.md", "a/b/c.md"], { docsPath }),
    ).toBeNull();
  });

  it("rejects a non-string override without falling back", () => {
    expect(findDocsFolder(["docs/a.md"], { docsPath: 5 as unknown as string })).toBeNull();
  });
});

describe("findDocsFolder malformed input", () => {
  it("returns null for null, undefined and non-iterables", () => {
    expect(findDocsFolder(null)).toBeNull();
    expect(findDocsFolder(undefined)).toBeNull();
    expect(findDocsFolder(42 as unknown as string[])).toBeNull();
    expect(findDocsFolder({} as unknown as string[])).toBeNull();
  });

  it("skips bad entries", () => {
    const entries = [null, 5, {}, { path: 7 }, "docs/a.md"] as unknown as string[];
    expect(findDocsFolder(entries)).toBe("docs");
  });

  it("skips unsafe default candidates and tolerates a bad defaults value", () => {
    expect(findDocsFolder(["docs/a.md"], { defaults: ["../x", "/y", "docs"] })).toBe("docs");
    expect(findDocsFolder(["docs/a.md"], { defaults: "docs" as unknown as string[] })).toBe("docs");
  });

  it("accepts any iterable", () => {
    expect(findDocsFolder(new Set(["Docs/a.md"]))).toBe("Docs");
  });
});

describe("normalizeDocsPath", () => {
  it("normalizes and rejects", () => {
    expect(normalizeDocsPath(" ./a/b/ ")).toBe("a/b");
    expect(normalizeDocsPath("a/../b")).toBeNull();
    expect(normalizeDocsPath(undefined)).toBeNull();
  });
});
