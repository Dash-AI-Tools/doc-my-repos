import { describe, expect, it } from "vitest";

import {
  MAX_FACET_CHARS,
  MAX_TAGS,
  buildDocumentRecord,
  toDbJson,
  toDbText,
  type BuildResult,
  type DocumentRecord,
} from "./document-record";

const opts = { docsFolder: "docs" };

function record(result: BuildResult): DocumentRecord {
  if (!result.ok) throw new Error(`expected a record, got ${result.reason}`);
  return result.record;
}

function build(text: string, path = "docs/guide.md") {
  return buildDocumentRecord(path, text, opts);
}

describe("buildDocumentRecord", () => {
  it("stores the parsed document: body without frontmatter, all keys, derived columns", () => {
    const r = build(
      "---\ntitle: Setup\ndescription: How to set up\ntype: Metric\ntags: [finance, ops]\nstatus: draft\nowner_team: core\n---\n# Heading one\n\n## Two\n\nText.\n",
    );
    const doc = record(r);
    expect(doc).toMatchObject({
      path: "docs/guide.md",
      title: "Setup",
      description: "How to set up",
      type: "Metric",
      tags: ["finance", "ops"],
      status: "draft",
      reserved: null,
    });
    expect(doc.frontmatter).toEqual({
      title: "Setup",
      description: "How to set up",
      type: "Metric",
      tags: ["finance", "ops"],
      status: "draft",
      owner_team: "core",
    });
    expect(doc.body).toBe("# Heading one\n\n## Two\n\nText.\n");
    expect(doc.headings.map((h) => h.text)).toEqual(["Heading one", "Two"]);
    expect(r.warnings).toEqual([]);
  });

  it("falls back to the first H1, then the file name, for the title", () => {
    expect(record(build("# Getting Started\n\nbody")).title).toBe("Getting Started");
    expect(record(build("---\ntype: Note\n---\nplain", "docs/my-note.md")).title).toBe("My note");
  });

  it("titles the docs-root index.md from its file name and nested ones from their folder", () => {
    expect(record(build("x", "docs/index.md")).title).toBe("Index");
    expect(record(build("x", "docs/guides/index.md")).title).toBe("Guides");
  });

  it("marks reserved index.md and log.md at any depth, but not index.mdx", () => {
    expect(record(build("x", "docs/index.md")).reserved).toBe("index");
    expect(record(build("x", "docs/a/LOG.md")).reserved).toBe("log");
    expect(record(build("x", "docs/index.mdx")).reserved).toBeNull();
  });

  it("keeps type verbatim, case and spacing included", () => {
    expect(record(build("---\ntype: metric\n---\n")).type).toBe("metric");
    expect(record(build('---\ntype: " Metric "\n---\n')).type).toBe(" Metric ");
  });

  it("stores a null type column for a non-string or blank type but keeps the key", () => {
    const numeric = build("---\ntype: 3\n---\nx");
    expect(record(numeric).type).toBeNull();
    expect(record(numeric).frontmatter).toEqual({ type: 3 });
    expect(numeric.warnings.join()).toMatch(/type/);

    const blank = record(build('---\ntype: ""\n---\nx'));
    expect(blank.type).toBeNull();
    expect(blank.frontmatter).toEqual({ type: "" });

    const nul = record(build("---\ntype:\n---\nx"));
    expect(nul.type).toBeNull();
    expect(nul.frontmatter).toEqual({ type: null });
  });

  it("drops an over-long type from the column with a warning", () => {
    const long = "T".repeat(MAX_FACET_CHARS + 1);
    const r = build(`---\ntype: ${long}\n---\n`);
    expect(record(r).type).toBeNull();
    expect(record(r).frontmatter.type).toBe(long);
    expect(r.warnings.join()).toMatch(/longer than/);
  });

  describe("tags", () => {
    it("is empty when absent or null", () => {
      expect(record(build("x")).tags).toEqual([]);
      expect(record(build("---\ntags:\n---\n")).tags).toEqual([]);
    });

    it("treats a single string as one tag without splitting", () => {
      expect(record(build("---\ntags: a, b\n---\n")).tags).toEqual(["a, b"]);
    });

    it("keeps order and case, drops blanks and exact duplicates silently", () => {
      const r = build('---\ntags: [B, a, B, "", "  ", A]\n---\n');
      expect(record(r).tags).toEqual(["B", "a", "A"]);
      expect(r.warnings).toEqual([]);
    });

    it("drops non-string entries with a warning", () => {
      const r = build("---\ntags: [2024, finance, {x: 1}, true]\n---\n");
      expect(record(r).tags).toEqual(["finance"]);
      expect(r.warnings.join()).toMatch(/tags/);
    });

    it("ignores a non-list value with a warning", () => {
      const r = build("---\ntags: {a: 1}\n---\n");
      expect(record(r).tags).toEqual([]);
      expect(r.warnings.join()).toMatch(/tags/);
    });

    it("caps the count and the length of tags", () => {
      const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${i}`);
      const r = build(`---\ntags: [${many.join(", ")}, ${"x".repeat(MAX_FACET_CHARS + 1)}]\n---\n`);
      expect(record(r).tags).toEqual(many.slice(0, MAX_TAGS));
      expect(r.warnings.join()).toMatch(/tags/);
    });
  });

  it("keeps status verbatim, null when not a usable string", () => {
    expect(record(build("---\nstatus: Deprecated\n---\n")).status).toBe("Deprecated");
    expect(record(build('---\nstatus: "  "\n---\n')).status).toBeNull();
    const r = build("---\nstatus: [a]\n---\n");
    expect(record(r).status).toBeNull();
    expect(r.warnings.join()).toMatch(/status/);
  });

  it("treats malformed frontmatter as no metadata with a warning, keeping the text", () => {
    const r = build("---\ntitle: [unclosed\n---\n# Real\n");
    const doc = record(r);
    expect(doc.frontmatter).toEqual({});
    expect(doc.type).toBeNull();
    expect(doc.title).toBe("Real");
    expect(doc.body).toContain("title: [unclosed");
    expect(r.warnings.join()).toMatch(/not valid YAML/);
  });

  it("removes NUL and replaces lone surrogates everywhere", () => {
    const doc = record(
      build(
        "---\nti\u0000tle: a\u0000b\ntags: [x\u0000y]\nstatus: s\ud800\n---\n# He\u0000ad\n\nbo\u0000dy \udc00\n",
        "docs/n\u0000ul.md",
      ),
    );
    const all = JSON.stringify(doc);
    expect(all).not.toContain("\\u0000");
    expect(all).not.toMatch(/\\ud800|\\udc00/i);
    expect(doc.path).toBe("docs/nul.md");
    expect(doc.frontmatter).toEqual({ title: "ab", tags: ["xy"], status: "s�" });
    expect(doc.body).toBe("# Head\n\nbody �\n");
    expect(doc.headings[0]?.text).toBe("Head");
  });

  it("skips a document over the byte cap without parsing it", () => {
    const text = "a".repeat(300 * 1024);
    const r = build(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_large");
    expect(r.bytes).toBe(300 * 1024);
    expect(r.warnings.join()).toMatch(/larger than 262144 bytes/);
  });

  it("measures the cap in UTF-8 bytes and accepts a document exactly at it", () => {
    expect(buildDocumentRecord("docs/a.md", "é".repeat(5), { ...opts, maxBytes: 10 }).ok).toBe(
      true,
    );
    expect(buildDocumentRecord("docs/a.md", "é".repeat(6), { ...opts, maxBytes: 10 }).ok).toBe(
      false,
    );
  });

  it("rejects a bad maxBytes", () => {
    expect(() => buildDocumentRecord("docs/a.md", "", { ...opts, maxBytes: 0 })).toThrow(TypeError);
  });

  it("builds an empty document", () => {
    const doc = record(build("", "docs/empty.md"));
    expect(doc).toMatchObject({ title: "Empty", body: "", tags: [], headings: [] });
  });
});

describe("toDbText / toDbJson", () => {
  it("cleans strings and keys at any depth", () => {
    expect(toDbText("a\u0000b\ud800")).toBe("ab�");
    expect(toDbJson({ "k\u0000": ["v\u0000", { x: "\udc00" }], n: 1, b: true, z: null })).toEqual({
      k: ["v", { x: "�" }],
      n: 1,
      b: true,
      z: null,
    });
  });
});
