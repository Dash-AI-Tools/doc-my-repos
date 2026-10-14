import { describe, expect, it } from "vitest";
import { detectOkf, isReservedFile, isTypedConcept, reservedKind } from "./okf";

const d = (path: string, frontmatter: Record<string, never | unknown> = {}) => ({
  path,
  frontmatter: frontmatter as never,
});

describe("isReservedFile", () => {
  it.each(["index.md", "docs/index.md", "docs/a/b/log.md", "docs/INDEX.md", "docs/Log.MD"])(
    "reserved: %s",
    (p) => expect(isReservedFile(p)).toBe(true),
  );
  it.each(["docs/a.md", "docs/index.mdx", "docs/log.mdx", "docs/myindex.md", "docs/index.md/x.md"])(
    "not reserved: %s",
    (p) => expect(isReservedFile(p)).toBe(false),
  );
  it("reports the kind", () => {
    expect(reservedKind("docs/x/Index.md")).toBe("index");
    expect(reservedKind("docs/LOG.md")).toBe("log");
    expect(reservedKind("docs/a.md")).toBeNull();
  });
});

describe("isTypedConcept", () => {
  it("true for a doc with a type key", () => {
    expect(isTypedConcept(d("docs/a.md", { type: "Metric" }))).toBe(true);
  });
  it("key presence counts, even blank, null or non-string", () => {
    for (const type of ["", null, 3, ["x"]]) {
      expect(isTypedConcept(d("docs/a.md", { type }))).toBe(true);
    }
  });
  it("false without the key or without frontmatter", () => {
    expect(isTypedConcept(d("docs/a.md", { title: "x" }))).toBe(false);
    expect(isTypedConcept({ path: "docs/a.md", frontmatter: null })).toBe(false);
    expect(isTypedConcept({ path: "docs/a.md", frontmatter: undefined })).toBe(false);
  });
  it("reserved files never count, even with type", () => {
    expect(isTypedConcept(d("docs/index.md", { type: "Note" }))).toBe(false);
    expect(isTypedConcept(d("docs/sub/log.md", { type: "Note" }))).toBe(false);
  });
  it("does not inherit type from the prototype", () => {
    expect(isTypedConcept(d("docs/a.md", Object.create({ type: "X" })))).toBe(false);
  });
});

describe("detectOkf by type", () => {
  it("typed doc makes it OKF", () => {
    expect(detectOkf([d("docs/a.md", { type: "Metric" })], "docs")).toEqual({
      isOkf: true,
      reason: "type",
    });
  });
  it("nested typed doc counts", () => {
    expect(detectOkf([d("docs/a/b/c.md", { type: "metric" })], "docs").reason).toBe("type");
  });
  it("typed .mdx counts as a document", () => {
    expect(detectOkf([d("docs/a.mdx", { type: "Note" })], "docs").isOkf).toBe(true);
  });
  it("no typed docs: not OKF", () => {
    expect(detectOkf([d("docs/a.md", { title: "A" }), d("docs/b.md")], "docs")).toEqual({
      isOkf: false,
    });
  });
  it("only index.md with type: not OKF", () => {
    expect(detectOkf([d("docs/index.md", { type: "Note" })], "docs").isOkf).toBe(false);
  });
  it("log.md with type is ignored", () => {
    expect(detectOkf([d("docs/log.md", { type: "Note" })], "docs").isOkf).toBe(false);
  });
  it("does not inspect or normalize the type value", () => {
    const frontmatter = { type: "  WeIrD Case " };
    const docs = [d("docs/a.md", frontmatter)];
    expect(detectOkf(docs, "docs").isOkf).toBe(true);
    expect(frontmatter.type).toBe("  WeIrD Case ");
  });
  it("blank type key still counts", () => {
    expect(detectOkf([d("docs/a.md", { type: "" })], "docs").reason).toBe("type");
  });
  it("empty docs list and null folder", () => {
    expect(detectOkf([], "docs")).toEqual({ isOkf: false });
    expect(detectOkf([d("docs/a.md", { type: "X" })], null)).toEqual({ isOkf: false });
  });
  it("ignores docs outside the docs folder", () => {
    expect(
      detectOkf([d("src/a.md", { type: "X" }), d("docs2/a.md", { type: "X" })], "docs"),
    ).toEqual({ isOkf: false });
  });
  it("works with a nested docs folder and trailing slash", () => {
    expect(detectOkf([d("packages/x/docs/a.md", { type: "X" })], "packages/x/docs/").isOkf).toBe(
      true,
    );
  });
});

describe("detectOkf by okf_version", () => {
  it("root index declaring okf_version makes it OKF and reports it", () => {
    expect(detectOkf([d("docs/index.md", { okf_version: "0.2" })], "docs")).toEqual({
      isOkf: true,
      reason: "okf_version",
      okfVersion: "0.2",
    });
  });
  it("root index matched case-insensitively", () => {
    expect(detectOkf([d("docs/INDEX.md", { okf_version: "0.2" })], "Docs").reason).toBe(
      "okf_version",
    );
  });
  it("nested index does not count", () => {
    expect(detectOkf([d("docs/sub/index.md", { okf_version: "0.2" })], "docs").isOkf).toBe(false);
  });
  it("repo-root index outside the docs folder does not count", () => {
    expect(detectOkf([d("index.md", { okf_version: "0.2" })], "docs").isOkf).toBe(false);
  });
  it("non-index files with okf_version do not count", () => {
    expect(detectOkf([d("docs/a.md", { okf_version: "0.2" })], "docs").isOkf).toBe(false);
    expect(detectOkf([d("docs/log.md", { okf_version: "0.2" })], "docs").isOkf).toBe(false);
    expect(detectOkf([d("docs/index.mdx", { okf_version: "0.2" })], "docs").isOkf).toBe(false);
  });
  it("number version counts and is stringified", () => {
    expect(detectOkf([d("docs/index.md", { okf_version: 0.2 })], "docs").okfVersion).toBe("0.2");
  });
  it.each([null, "", "   ", undefined])("missing or blank (%s) does not declare", (v) => {
    expect(detectOkf([d("docs/index.md", { okf_version: v })], "docs").isOkf).toBe(false);
  });
  it("no okf_version key and no frontmatter", () => {
    expect(detectOkf([d("docs/index.md", {})], "docs").isOkf).toBe(false);
    expect(detectOkf([{ path: "docs/index.md", frontmatter: null }], "docs").isOkf).toBe(false);
  });
  it("odd value declares but has no version", () => {
    expect(detectOkf([d("docs/index.md", { okf_version: ["x"] })], "docs")).toEqual({
      isOkf: true,
      reason: "okf_version",
      okfVersion: null,
    });
  });
  it("type reason wins over okf_version", () => {
    const docs = [d("docs/index.md", { okf_version: "0.2" }), d("docs/a.md", { type: "X" })];
    expect(detectOkf(docs, "docs").reason).toBe("type");
  });
});

describe("detectOkf okfVersion alongside a typed doc", () => {
  it("reports the root index version even when a typed doc decides first", () => {
    const result = detectOkf(
      [
        { path: "docs/a.md", frontmatter: { type: "Concept" } },
        { path: "docs/index.md", frontmatter: { okf_version: "0.2" } },
      ],
      "docs",
    );
    expect(result).toEqual({ isOkf: true, reason: "type", okfVersion: "0.2" });
  });

  it("omits okfVersion when the root index declares none", () => {
    const result = detectOkf([{ path: "docs/a.md", frontmatter: { type: "Concept" } }], "docs");
    expect(result).toEqual({ isOkf: true, reason: "type" });
  });
});
