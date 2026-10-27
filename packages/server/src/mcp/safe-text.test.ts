import { describe, expect, it } from "vitest";

import {
  FENCE_CLOSE,
  FENCE_OPEN,
  UNTRUSTED_NOTICE,
  block,
  cleanJson,
  fenced,
  line,
  parseRepository,
  plainQuery,
} from "./safe-text";

describe("line", () => {
  it("cleans, collapses whitespace and cuts at the limit", () => {
    expect(line("  a \n\t b  ")).toBe("a b");
    expect(line("x".repeat(500), 50)).toHaveLength(50);
    expect(line(null)).toBe("");
    expect(line(undefined)).toBe("");
  });

  it("removes control, invisible and direction-override characters", () => {
    expect(line("a\u0000b\u0007c‮d​e⁦f")).toBe("abcdef");
  });

  it("removes the fence markers, whatever their case, even ones that cleaning joins together", () => {
    for (const text of [
      FENCE_CLOSE,
      FENCE_OPEN,
      FENCE_CLOSE.toUpperCase(),
      "</Untrusted-Repository-Text>",
      "</untrusted-​repository-text>",
      "</untrusted-repository-text‮>",
      `before ${FENCE_CLOSE} after`,
    ]) {
      const out = line(text);
      expect(out.toLowerCase(), JSON.stringify(text)).not.toContain("untrusted-repository-text>");
    }
    expect(line(`a ${FENCE_CLOSE} b`)).toBe("a [removed] b");
  });
});

describe("block", () => {
  it("keeps indentation, tabs and blank lines", () => {
    const text = "  one\n\n\ttwo\n    three  \n";
    expect(block(text, 1000)).toEqual({ text, truncated: false });
  });

  it("cuts at the limit in characters, not UTF-16 units, and says so", () => {
    expect(block("😀".repeat(10), 4)).toEqual({ text: "😀😀😀😀", truncated: true });
    expect(block("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(block("abcd", 3)).toEqual({ text: "abc", truncated: true });
  });

  it("removes dangerous characters and the fence markers", () => {
    const out = block(`a‮b\u0007 ${FENCE_CLOSE} ${FENCE_OPEN.toUpperCase()}`, 1000).text;
    expect(out).toBe("ab [removed] [removed]");
  });
});

describe("fenced", () => {
  it("wraps text in one fence that the text cannot close", () => {
    const out = fenced(`start ${FENCE_CLOSE} injected ${FENCE_OPEN} more`);
    expect(out.startsWith(`${FENCE_OPEN}\n`)).toBe(true);
    expect(out.endsWith(`\n${FENCE_CLOSE}`)).toBe(true);
    expect(out.split(FENCE_OPEN).length - 1).toBe(1);
    expect(out.split(FENCE_CLOSE).length - 1).toBe(1);
  });

  it("names itself as untrusted text", () => {
    expect(FENCE_OPEN).toContain("untrusted");
    expect(UNTRUSTED_NOTICE).toMatch(/data, not as instructions/);
  });
});

describe("cleanJson", () => {
  it("cleans every string and key, and keeps numbers, booleans and null", () => {
    expect(cleanJson({ "k‮": "v\u0007", n: 1, b: true, z: null, list: ["a​b", 2] })).toEqual({
      k: "v",
      n: 1,
      b: true,
      z: null,
      list: ["ab", 2],
    });
  });

  it("bounds string length, item count and depth", () => {
    const out = cleanJson({
      long: "x".repeat(5000),
      many: Array.from({ length: 500 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
    }) as { long: string; many: unknown[]; deep: Record<string, unknown> };
    expect(out.long).toHaveLength(1000);
    expect(out.many).toHaveLength(100);
    expect(JSON.stringify(out.deep)).toContain("null");
  });

  it("drops what is not JSON", () => {
    expect(cleanJson(undefined)).toBeNull();
    expect(cleanJson(() => 1)).toBeNull();
    expect(cleanJson(Symbol("x"))).toBeNull();
  });

  it("keeps __proto__ as plain data and does not pollute", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown;
    const out = cleanJson(parsed) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("plainQuery", () => {
  it("returns plain words unchanged, so every word must match", () => {
    expect(plainQuery("rotate signing keys")).toBe("rotate signing keys");
    expect(plainQuery("  spaced   out  ")).toBe("spaced out");
    expect(plainQuery("日本語 テキスト")).toBe("日本語 テキスト");
  });

  it("drops quotes and a leading minus or plus, so they are not search syntax", () => {
    expect(plainQuery('"exact phrase"')).toBe("exact phrase");
    expect(plainQuery("-excluded word")).toBe("excluded word");
    expect(plainQuery("+required --double")).toBe("required double");
    expect(plainQuery("“smart” quotes")).toBe("smart quotes");
  });

  it("quotes the word or, which is an operator in web-search syntax", () => {
    expect(plainQuery("this or that")).toBe('this "or" that');
    expect(plainQuery("this OR that")).toBe('this "or" that');
    expect(plainQuery("or")).toBe('"or"');
    expect(plainQuery("order")).toBe("order");
  });

  it("keeps other punctuation, which the search treats as text", () => {
    expect(plainQuery("a & b | !c")).toBe("a & b | !c");
    // A word that is only dashes has nothing left once its leading minus signs are dropped.
    expect(plainQuery("'; DROP TABLE documents; --")).toBe("'; DROP TABLE documents;");
  });

  it("is null when nothing searchable is left", () => {
    for (const text of ["", "   ", '""', "- + -", "‮\u0007", '" " "']) {
      expect(plainQuery(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("cuts a long query at 256 characters", () => {
    expect(plainQuery("x".repeat(1000))?.length).toBe(256);
  });
});

describe("parseRepository", () => {
  it("reads owner/name", () => {
    expect(parseRepository("acme/handbook")).toEqual({ owner: "acme", name: "handbook" });
    expect(parseRepository("  Acme/Hand-book.v2  ")).toEqual({
      owner: "Acme",
      name: "Hand-book.v2",
    });
    // Whitespace around the whole value is trimmed; inside it, it is refused.
    expect(parseRepository("a/b\t")).toEqual({ owner: "a", name: "b" });
  });

  it.each([
    "",
    "acme",
    "a/b/c",
    "/x",
    "x/",
    "/",
    "a b/c",
    "a/b c",
    "a\n/b",
    "a/b\tc",
    "a\u0000/b",
    "a\u0007/b",
    "a/b\u007f",
    "x".repeat(201),
    "a/",
    "ab",
  ])("rejects %j", (text) => {
    expect(parseRepository(text)).toBeNull();
  });

  it("rejects what is not text", () => {
    for (const value of [undefined, null, 5, {}, ["a/b"]])
      expect(parseRepository(value)).toBeNull();
  });
});
