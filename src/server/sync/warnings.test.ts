import { describe, expect, it } from "vitest";

import {
  MAX_WARNING_PATH_CHARS,
  MAX_WARNING_PATHS,
  buildRepoSyncWarnings,
  cappedRunWarning,
  formatByteLimit,
} from "./warnings";

const KB256 = 256 * 1024;

describe("buildRepoSyncWarnings", () => {
  it("is empty when nothing was left out", () => {
    expect(buildRepoSyncWarnings({ skipped: [], maxFileBytes: KB256 })).toEqual([]);
  });

  it("groups skips by reason, in a fixed order, with sorted paths and counts", () => {
    const warnings = buildRepoSyncWarnings({
      skipped: [
        { path: "docs/z.md", reason: "too_large" },
        { path: "docs/b.md", reason: "over_limit" },
        { path: "docs/a.md", reason: "over_limit" },
        { path: "docs/link.md", reason: "not_regular_file" },
        { path: "docs/bad.md", reason: "invalid_entry" },
        { path: "docs/r.md", reason: "write_rejected" },
        { path: "docs/u.md", reason: "size_unknown" },
        { path: "docs/y.md", reason: "too_large" },
      ],
      capped: { found: 12, limit: 10 },
      maxFileBytes: KB256,
    });
    expect(warnings.map((w) => [w.code, w.count, w.paths])).toEqual([
      ["docs_capped", 2, ["docs/a.md", "docs/b.md"]],
      ["too_large", 2, ["docs/y.md", "docs/z.md"]],
      ["size_unknown", 1, ["docs/u.md"]],
      ["write_rejected", 1, ["docs/r.md"]],
      ["unsupported", 2, ["docs/bad.md", "docs/link.md"]],
    ]);
    expect(warnings[0]?.message).toBe(
      "Only the first 10 of 12 documentation files were synced (limit 10 per repository); 2 files left out.",
    );
    expect(warnings[1]?.message).toBe("2 files larger than 256 KB were not synced.");
    expect(warnings[2]?.message).toBe("1 file without a known size was not synced.");
  });

  it("does not warn about files left out by convention", () => {
    expect(
      buildRepoSyncWarnings({
        skipped: [
          { path: "docs/node_modules/a.md", reason: "ignored_folder" },
          { path: "docs/.hidden.md", reason: "hidden" },
        ],
        maxFileBytes: KB256,
      }),
    ).toEqual([]);
  });

  it("deduplicates paths reported twice (selection and persist)", () => {
    const [w] = buildRepoSyncWarnings({
      skipped: [
        { path: "docs/a.md", reason: "too_large" },
        { path: "docs/a.md", reason: "too_large" },
      ],
      maxFileBytes: 1000,
    });
    expect(w).toMatchObject({ count: 1, paths: ["docs/a.md"] });
    expect(w?.message).toBe("1 file larger than 1000 bytes was not synced.");
  });

  it("bounds the path list and each path, keeping the real count", () => {
    const skipped = Array.from({ length: 2500 }, (_, i) => ({
      path: `docs/${String(i).padStart(5, "0")}${i === 0 ? "x".repeat(2000) : ""}.md`,
      reason: "over_limit",
    }));
    const [w] = buildRepoSyncWarnings({
      skipped,
      capped: { found: 4500, limit: 2000 },
      maxFileBytes: KB256,
    });
    expect(w?.count).toBe(2500);
    expect(w?.paths).toHaveLength(MAX_WARNING_PATHS);
    expect(w?.paths[0]?.length).toBe(MAX_WARNING_PATH_CHARS);
    expect(w?.paths[0]?.endsWith("…")).toBe(true);
    expect(JSON.stringify(w).length).toBeLessThan(20_000);
  });

  it("strips characters Postgres cannot store", () => {
    const [w] = buildRepoSyncWarnings({
      skipped: [{ path: "docs/a\u0000b.md", reason: "too_large" }],
      maxFileBytes: KB256,
    });
    expect(w?.paths[0]).not.toContain("\u0000");
  });
});

describe("formatByteLimit and cappedRunWarning", () => {
  it("formats limits", () => {
    expect(formatByteLimit(262144)).toBe("256 KB");
    expect(formatByteLimit(1024)).toBe("1 KB");
    expect(formatByteLimit(1500)).toBe("1500 bytes");
    expect(formatByteLimit(1)).toBe("1 byte");
  });

  it("describes a capped run", () => {
    expect(cappedRunWarning({ found: 2345, limit: 2000 })).toEqual({
      path: null,
      message: "document limit reached: 2345 docs files found, only the first 2000 synced",
    });
  });

  it("groups API spec skips apart from documents, after them, with fixed messages", () => {
    const warnings = buildRepoSyncWarnings({
      skipped: [{ path: "docs/a.md", reason: "too_large" }],
      maxFileBytes: KB256,
      apiSpecs: {
        maxSpecBytes: 2 * 1024 * 1024,
        limit: 10,
        skipped: [
          { path: "z.yaml", reason: "over_limit" },
          { path: "y.yaml", reason: "over_limit" },
          { path: "big.yaml", reason: "too_large" },
          { path: "bad.yaml", reason: "invalid" },
          { path: "rej.yaml", reason: "write_rejected" },
          { path: "api/none.yaml", reason: "missing" },
          { path: "link.yaml", reason: "not_regular_file" },
          { path: ".hidden/openapi.yaml", reason: "hidden" },
        ],
      },
    });
    expect(warnings.map((w) => [w.code, w.count, w.paths])).toEqual([
      ["too_large", 1, ["docs/a.md"]],
      ["api_spec_over_limit", 2, ["y.yaml", "z.yaml"]],
      ["api_spec_too_large", 1, ["big.yaml"]],
      ["api_spec_invalid", 2, ["bad.yaml", "rej.yaml"]],
      ["api_spec_missing", 1, ["api/none.yaml"]],
      ["api_spec_unsupported", 2, [".hidden/openapi.yaml", "link.yaml"]],
    ]);
    expect(warnings[1]?.message).toBe(
      "Only the first 10 API spec files per repository are shown; 2 files left out.",
    );
    expect(warnings[2]?.message).toBe(
      "1 file larger than 2048 KB was not shown as an API reference.",
    );
  });
});
