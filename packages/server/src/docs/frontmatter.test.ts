import { describe, expect, it } from "vitest";

import {
  MAX_FRONTMATTER_BYTES,
  MAX_FRONTMATTER_DEPTH,
  MAX_FRONTMATTER_NODES,
  parseFrontmatter,
  sanitizeFrontmatter,
} from "./frontmatter";

/** True when no lone surrogate is left (stronger than JSON.parse, which accepts escapes). */
function wellFormed(value: string): boolean {
  return value.toWellFormed() === value;
}

function assertAllWellFormed(value: unknown): void {
  if (typeof value === "string") {
    expect(wellFormed(value)).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach(assertAllWellFormed);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      expect(wellFormed(key)).toBe(true);
      assertAllWellFormed(child);
    }
  }
}

describe("parseFrontmatter", () => {
  it("parses valid frontmatter and returns the body", () => {
    const r = parseFrontmatter(
      "---\ntitle: Hello\ntype: Metric\ntags: [a, b]\nstatus: draft\n---\n# Body\n",
    );
    expect(r.frontmatter).toEqual({
      title: "Hello",
      type: "Metric",
      tags: ["a", "b"],
      status: "draft",
    });
    expect(r.type).toBe("Metric");
    expect(r.body).toBe("# Body\n");
    expect(r.warnings).toEqual([]);
  });

  it("returns the input as body when there is no frontmatter", () => {
    const r = parseFrontmatter("# Title\n\ntext\n");
    expect(r).toEqual({ frontmatter: {}, body: "# Title\n\ntext\n", type: null, warnings: [] });
    expect(parseFrontmatter("").body).toBe("");
  });

  it("handles only `type`", () => {
    const r = parseFrontmatter("---\ntype: Note\n---\nhi");
    expect(r.frontmatter).toEqual({ type: "Note" });
    expect(r.type).toBe("Note");
    expect(r.body).toBe("hi");
    expect(r.warnings).toEqual([]);
  });

  it("does not throw on malformed YAML and keeps the whole text as body with a warning", () => {
    const text = "---\ntitle: [unclosed\nfoo: : bar\n---\n# Body";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.type).toBeNull();
    expect(r.body).toBe(text);
    expect(r.warnings).toEqual(["frontmatter ignored: not valid YAML"]);
  });

  it("keeps all prose when a `---` span is prose, not a mapping", () => {
    const text = "---\n\nIntro paragraph.\n\nMore.\n\n---\nafter";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(text);
    expect(r.warnings).toEqual(["frontmatter ignored: not a key/value mapping"]);
  });

  it("keeps the whole text when a fence-like line breaks the YAML", () => {
    const text = "---\ntype: A\n--- trailing\nx\n---\nb";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(text);
    expect(r.warnings).toHaveLength(1);
  });

  it("keeps the full body for a horizontal rule followed by prose", () => {
    const text = "---\nSome prose after a rule.\n\nMore prose.\n---\nend";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.type).toBeNull();
    expect(r.body).toBe(text);
    expect(r.warnings).toHaveLength(1);
  });

  it("does not quote document text in warnings", () => {
    const r = parseFrontmatter("---\nsecret-sentinel: [\n---\nx");
    expect(r.warnings.join("\n")).not.toContain("sentinel");
  });

  it("preserves unknown keys with original order and case", () => {
    const r = parseFrontmatter(
      "---\nZeta: 1\nowner_team: core\nAlpha: {B: 2, a: [1, {x: null}]}\nflag: true\n---\n",
    );
    expect(Object.keys(r.frontmatter)).toEqual(["Zeta", "owner_team", "Alpha", "flag"]);
    expect(r.frontmatter.Alpha).toEqual({ B: 2, a: [1, { x: null }] });
    expect(Object.keys(r.frontmatter.Alpha as object)).toEqual(["B", "a"]);
  });

  it("keeps `type` verbatim without case normalization or trimming", () => {
    expect(parseFrontmatter("---\ntype: mEtRiC\n---\n").type).toBe("mEtRiC");
    expect(parseFrontmatter('---\ntype: " Spaced "\n---\n').type).toBe(" Spaced ");
    expect(parseFrontmatter("---\nType: Metric\n---\n").type).toBeNull();
  });

  it("does not coerce a non-string `type`, keeps it in frontmatter and warns", () => {
    for (const [yaml, value] of [
      ["2024", 2024],
      ["true", true],
      ["[a, b]", ["a", "b"]],
      ["{k: v}", { k: "v" }],
    ] as const) {
      const r = parseFrontmatter(`---\ntype: ${yaml}\n---\n`);
      expect(r.type).toBeNull();
      expect(r.frontmatter.type).toEqual(value);
      expect(r.warnings).toHaveLength(1);
    }
    const empty = parseFrontmatter("---\ntype:\n---\n");
    expect(empty.type).toBeNull();
    expect(empty.frontmatter).toEqual({ type: null });
    expect(empty.warnings).toEqual([]);
    expect(parseFrontmatter('---\ntype: ""\n---\n').type).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const r = parseFrontmatter("---\r\ntitle: Hi\r\ntype: Note\r\n---\r\n# Body\r\n");
    expect(r.frontmatter).toEqual({ title: "Hi", type: "Note" });
    expect(r.body).toBe("# Body\r\n");
    expect(r.warnings).toEqual([]);
  });

  it("strips a leading BOM", () => {
    const r = parseFrontmatter("﻿---\ntype: Note\n---\nbody");
    expect(r.frontmatter).toEqual({ type: "Note" });
    expect(r.body).toBe("body");
    expect(parseFrontmatter("﻿# Hi").body).toBe("# Hi");
  });

  it("treats an unterminated fence as no frontmatter, with a warning", () => {
    const text = "---\ntitle: x\n\n# Body\n";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(text);
    expect(r.warnings).toHaveLength(1);
  });

  it("accepts an empty block and a comment-only block", () => {
    for (const text of ["---\n---\nbody", "---\n# nothing\n---\nbody"]) {
      const r = parseFrontmatter(text);
      expect(r).toEqual({ frontmatter: {}, body: "body", type: null, warnings: [] });
    }
  });

  it("accepts `...` as the closing fence and trailing spaces on fences", () => {
    expect(parseFrontmatter("---\ntype: A\n...\nbody").frontmatter).toEqual({ type: "A" });
    expect(parseFrontmatter("---  \ntype: A\n---\t\nbody").body).toBe("body");
  });

  it("handles a closing fence at end of input with no body", () => {
    const r = parseFrontmatter("---\ntype: A\n---");
    expect(r.frontmatter).toEqual({ type: "A" });
    expect(r.body).toBe("");
  });

  it("does not take a horizontal rule later in the body for frontmatter", () => {
    const text = "# Title\n\n---\n\ntype: x\n\n---\nmore";
    expect(parseFrontmatter(text)).toEqual({
      frontmatter: {},
      body: text,
      type: null,
      warnings: [],
    });
  });

  it("does not take `----` or an indented `---` for a fence", () => {
    expect(parseFrontmatter("----\ntype: A\n----\n").frontmatter).toEqual({});
    expect(parseFrontmatter(" ---\ntype: A\n---\n").frontmatter).toEqual({});
  });

  it("ignores non-mapping frontmatter (list, scalar) with a warning and keeps the block", () => {
    for (const block of ["- a\n- b", "just text", "42"]) {
      const text = `---\n${block}\n---\nbody`;
      const r = parseFrontmatter(text);
      expect(r.frontmatter).toEqual({});
      expect(r.body).toBe(text);
      expect(r.warnings).toEqual(["frontmatter ignored: not a key/value mapping"]);
    }
  });

  it("strips NUL characters from input, keys and values", () => {
    const r = parseFrontmatter(
      '---\ntitle: "a\\0b"\n"k\\u0000ey": "v\\x00"\ntype: N\u0000ote\n---\nbo\u0000dy',
    );
    expect(r.frontmatter).toEqual({ title: "ab", key: "v", type: "Note" });
    expect(r.type).toBe("Note");
    expect(r.body).toBe("body");
    expect(JSON.stringify(r)).not.toContain("\\u0000");
  });

  it("strips NUL from nested keys and values", () => {
    const r = parseFrontmatter('---\nouter:\n  "a\\0": ["x\\0", {"b\\0": "c\\0"}]\n---\n');
    expect(r.frontmatter).toEqual({ outer: { a: ["x", { b: "c" }] } });
  });

  it("ignores a block over the size cap", () => {
    const big = `---\ntype: A\nnote: ${"x".repeat(MAX_FRONTMATTER_BYTES)}\n---\nbody`;
    const r = parseFrontmatter(big);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(big);
    expect(r.warnings).toHaveLength(1);
  });

  it("measures the size cap in bytes, not characters", () => {
    // 40k two-byte characters: under the cap by length, over it by bytes.
    const text = `---\ntype: A\nnote: ${"\u00e9".repeat(40_000)}\n---\nbody`;
    expect(text.length).toBeLessThan(MAX_FRONTMATTER_BYTES);
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(text);
    expect(r.warnings).toEqual([
      `frontmatter ignored: block is larger than ${MAX_FRONTMATTER_BYTES} bytes`,
    ]);
  });

  it("rejects a block with more values than the node cap", () => {
    const items = Array(MAX_FRONTMATTER_NODES + 1)
      .fill("0")
      .join(",");
    const text = `---\ntype: A\nx: [${items}]\n---\nbody`;
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_FRONTMATTER_BYTES);
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.type).toBeNull();
    expect(r.body).toBe(text);
    expect(r.warnings).toEqual(["frontmatter ignored: frontmatter has too many values"]);
  });

  it("rejects an alias expansion bomb quickly", () => {
    const lines = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let i = 1; i <= 9; i++) {
      const prev = String.fromCharCode(96 + i);
      const name = String.fromCharCode(97 + i);
      lines.push(`${name}: &${name} [${Array(9).fill(`*${prev}`).join(",")}]`);
    }
    const start = Date.now();
    const text = `---\n${lines.join("\n")}\n---\nbody`;
    const r = parseFrontmatter(text);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(text);
    expect(r.warnings).toHaveLength(1);
  });

  it("rejects an alias to its own ancestor", () => {
    const r = parseFrontmatter("---\nx: &a [*a]\n---\nbody");
    expect(r.frontmatter).toEqual({});
    expect(r.warnings).toHaveLength(1);
  });

  it("allows a few shared aliases", () => {
    const r = parseFrontmatter("---\nbase: &b {k: v}\ncopy: *b\n---\n");
    expect(r.frontmatter).toEqual({ base: { k: "v" }, copy: { k: "v" } });
  });

  it("rejects deep nesting without throwing", () => {
    const deep = "[".repeat(MAX_FRONTMATTER_DEPTH + 5) + "]".repeat(MAX_FRONTMATTER_DEPTH + 5);
    const r = parseFrontmatter(`---\nx: ${deep}\n---\nbody`);
    expect(r.frontmatter).toEqual({});
    expect(r.warnings).toHaveLength(1);
    const huge = "[".repeat(20_000);
    expect(() => parseFrontmatter(`---\nx: ${huge}\n---\n`)).not.toThrow();
  });

  it("makes non-JSON-safe values JSON-safe", () => {
    const r = parseFrontmatter(
      "---\ninf: .inf\nnan: .nan\nneg: -.inf\ndate: 2024-01-02\nbin: !!binary aGk=\nbig: 12345678901234567890\n1: one\n? [a, b]\n: pair\nnull: x\n---\n",
    );
    expect(() => JSON.parse(JSON.stringify(r.frontmatter))).not.toThrow();
    expect(JSON.parse(JSON.stringify(r.frontmatter))).toEqual(r.frontmatter);
    expect(r.frontmatter.inf).toBeNull();
    expect(r.frontmatter.nan).toBeNull();
    expect(r.frontmatter.neg).toBeNull();
    expect(r.frontmatter.date).toBe("2024-01-02");
    expect(r.frontmatter["1"]).toBe("one");
    expect(r.frontmatter.bin).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("keeps a `__proto__` key as data and does not pollute", () => {
    const r = parseFrontmatter("---\n__proto__: {polluted: true}\ntype: A\n---\n");
    expect(Object.keys(r.frontmatter)).toEqual(["__proto__", "type"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("lets the last duplicate key win instead of dropping metadata", () => {
    const r = parseFrontmatter("---\ntype: A\ntype: B\n---\n");
    expect(r.frontmatter).toEqual({ type: "B" });
    expect(r.warnings).toEqual([]);
  });

  it("keeps a second `---` document marker out of the frontmatter", () => {
    const r = parseFrontmatter("---\ntype: A\n---\nbody\n---\nmore");
    expect(r.frontmatter).toEqual({ type: "A" });
    expect(r.body).toBe("body\n---\nmore");
  });

  it("keeps every character of the document when the block is unusable", () => {
    const text = "---\n- a\n---\n# Heading\n\nProse.";
    expect(parseFrontmatter(`\ufeff${text}`).body).toBe(text);
    expect(parseFrontmatter(text.replace("Prose", "Pr\u0000ose")).body).toBe(text);
  });

  it("collapses keys that collide once NUL is stripped, last one winning", () => {
    expect(parseFrontmatter('---\n"a\\0": 1\na: 2\n---\n').frontmatter).toEqual({ a: 2 });
    expect(parseFrontmatter('---\na: 1\n"a\\0": 2\n---\n').frontmatter).toEqual({ a: 2 });
  });

  it("does not treat CR-only line endings as fences, and warns", () => {
    const text = "---\rtype: A\r---\rbody";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({});
    expect(r.type).toBeNull();
    expect(r.body).toBe(text);
    expect(r.warnings).toEqual(["frontmatter ignored: CR-only line endings are not supported"]);
  });

  it("replaces lone surrogates in keys, values, type and body", () => {
    const r = parseFrontmatter(
      '---\nv: "a\\ud800b"\n"k\\udc00": 1\ntype: "\\ud83d"\nlist: ["\\udc00x", {"\\ud800": "\\ud83d!"}]\n---\nbo\ud800dy \udc00 end\ud83d',
    );
    expect(r.frontmatter.v).toBe("a\ufffdb");
    expect(Object.keys(r.frontmatter)).toContain("k\ufffd");
    expect(r.type).toBe("\ufffd");
    expect(r.body).toBe("bo\ufffddy \ufffd end\ufffd");
    assertAllWellFormed(r.frontmatter);
    expect(wellFormed(r.body)).toBe(true);
    expect(wellFormed(r.type ?? "")).toBe(true);
  });

  it("replaces raw lone surrogates in the input, including in unusable blocks", () => {
    const raw = parseFrontmatter("---\nv: a\ud800b\n\udc00k: 1\n---\nx\ud83d");
    assertAllWellFormed(raw.frontmatter);
    expect(raw.frontmatter.v).toBe("a\ufffdb");
    expect(wellFormed(raw.body)).toBe(true);
    const unusable = parseFrontmatter("---\n- \ud800\n---\n\udc00");
    expect(wellFormed(unusable.body)).toBe(true);
  });

  it("keeps valid surrogate pairs intact", () => {
    const r = parseFrontmatter("---\ntype: \u{1f600}\n---\n\u{1f600}");
    expect(r.type).toBe("\u{1f600}");
    expect(r.body).toBe("\u{1f600}");
  });
});

describe("sanitizeFrontmatter", () => {
  it("turns an invalid Date into null and a valid one into an ISO string", () => {
    const r = sanitizeFrontmatter({ bad: new Date(Number.NaN), good: new Date(0) });
    expect(r).toEqual({
      ok: true,
      value: { bad: null, good: "1970-01-01T00:00:00.000Z" },
      notes: new Set(),
    });
  });

  it("turns a bigint into a decimal string", () => {
    const r = sanitizeFrontmatter({ big: 12345678901234567890n });
    expect(r).toEqual({
      ok: true,
      value: { big: "12345678901234567890" },
      notes: new Set(),
    });
  });

  it("replaces unsupported values with null and notes them", () => {
    const r = sanitizeFrontmatter({ f: () => 1, m: new Map(), u: undefined, s: Symbol("x") });
    expect(r.ok && r.value).toEqual({ f: null, m: null, u: null, s: null });
    expect(r.ok && r.notes.size).toBe(1);
  });
});
