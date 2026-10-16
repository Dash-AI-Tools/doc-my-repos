import { describe, expect, it } from "vitest";

import {
  MAX_COMMENT_LENGTH,
  cleanComment,
  commentLength,
  displayName,
  linkify,
  type CommentToken,
} from "./comments";

const text = (t: string): CommentToken => ({ kind: "text", text: t });
const link = (t: string, href = t): CommentToken => ({ kind: "link", text: t, href });
const ok = (input: string): string => {
  const r = cleanComment(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.text;
};

describe("cleanComment", () => {
  it("keeps ordinary text, tabs and line feeds", () => {
    expect(ok("a\tb\nc")).toBe("a\tb\nc");
    expect(ok("Two\n\nparagraphs")).toBe("Two\n\nparagraphs");
  });

  it("normalizes CRLF, CR and Unicode line separators to LF", () => {
    expect(ok("a\r\nb\rc d e")).toBe("a\nb\nc\nd\ne");
  });

  it("removes control characters, NUL, DEL and C1 controls", () => {
    expect(ok("a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg")).toBe("abcdefg");
  });

  it("removes bidirectional overrides, isolates and marks", () => {
    expect(ok("a‮b‪c⁦d⁩e‏f؜g")).toBe("abcdefg");
  });

  it("removes zero-width marks and the byte order mark", () => {
    expect(ok("a​b‌c‍d⁠e﻿f")).toBe("abcdef");
  });

  it("removes lone surrogates but keeps valid pairs", () => {
    expect(ok("a\ud800b\udc00c\u{1F600}")).toBe("abc\u{1F600}");
  });

  it("trims the ends, including text that is only invisible after cleaning", () => {
    expect(ok("  \n hi \t\n")).toBe("hi");
    expect(cleanComment("​ ‮\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(cleanComment("")).toEqual({ ok: false, reason: "empty" });
    expect(cleanComment("   \t\r\n  ")).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly 4000 code points and rejects 4001", () => {
    expect(cleanComment("x".repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
    expect(cleanComment("x".repeat(MAX_COMMENT_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("counts emoji and astral characters by code point, not UTF-16 units", () => {
    const emoji = "\u{1F600}".repeat(MAX_COMMENT_LENGTH);
    expect(emoji.length).toBe(8000);
    expect(cleanComment(emoji).ok).toBe(true);
    expect(cleanComment(emoji + "\u{1F600}")).toEqual({ ok: false, reason: "too_long" });
    expect(commentLength("a\u{1F600}b")).toBe(3);
  });

  it("counts after cleaning: removed characters do not count toward the limit", () => {
    expect(cleanComment("x".repeat(MAX_COMMENT_LENGTH) + "​".repeat(50)).ok).toBe(true);
  });

  it("rejects a huge input without scanning it all", () => {
    expect(cleanComment("x".repeat(1_000_000))).toEqual({ ok: false, reason: "too_long" });
  });

  it("leaves markup and Markdown as literal text", () => {
    expect(ok("<script>alert(1)</script> **bold**")).toBe("<script>alert(1)</script> **bold**");
  });
});

describe("displayName", () => {
  it("is the part before the @", () => {
    expect(displayName("ana@example.com")).toBe("ana");
    expect(displayName("  ana.b+tag@example.com ")).toBe("ana.b+tag");
  });

  it("splits at the first @", () => {
    expect(displayName("a@b@c")).toBe("a");
  });

  it("falls back to the whole email when the local part is empty or there is no @", () => {
    expect(displayName("@example.com")).toBe("@example.com");
    expect(displayName("plain")).toBe("plain");
  });
});

describe("linkify", () => {
  it("returns one text token when there is no address", () => {
    expect(linkify("nothing here")).toEqual([text("nothing here")]);
    expect(linkify("")).toEqual([]);
  });

  it("links an http(s) address in the middle of text", () => {
    expect(linkify("see https://example.com/page now")).toEqual([
      text("see "),
      link("https://example.com/page"),
      text(" now"),
    ]);
    expect(linkify("http://example.com")).toEqual([
      link("http://example.com", "http://example.com/"),
    ]);
  });

  it("excludes trailing punctuation", () => {
    expect(linkify("go to https://example.com/a.")).toEqual([
      text("go to "),
      link("https://example.com/a"),
      text("."),
    ]);
    expect(linkify("(https://example.com/a), ok?")).toEqual([
      text("("),
      link("https://example.com/a"),
      text("), ok?"),
    ]);
    expect(linkify("https://example.com/a?!.,;:")).toEqual([
      link("https://example.com/a"),
      text("?!.,;:"),
    ]);
  });

  it("handles nested trailing punctuation and keeps balanced brackets", () => {
    expect(linkify("(see [https://example.com/a].)")).toEqual([
      text("(see ["),
      link("https://example.com/a"),
      text("].)"),
    ]);
    expect(linkify("https://en.example.org/wiki/Foo_(bar)")).toEqual([
      link("https://en.example.org/wiki/Foo_(bar)"),
    ]);
    expect(linkify('"https://example.com/a".')).toEqual([
      text('"'),
      link("https://example.com/a"),
      text('".'),
    ]);
  });

  it("links several addresses and keeps the text between them", () => {
    expect(linkify("https://a.example https://b.example")).toEqual([
      link("https://a.example", "https://a.example/"),
      text(" "),
      link("https://b.example", "https://b.example/"),
    ]);
  });

  it("never links javascript:, data:, file: or other schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "ftp://example.com",
      "//example.com",
      "www.example.com",
    ]) {
      expect(linkify(`x ${bad} y`)).toEqual([text(`x ${bad} y`)]);
    }
  });

  it("does not link inside a word, and a link after a bad scheme is only the https part", () => {
    expect(linkify("xhttps://example.com")).toEqual([text("xhttps://example.com")]);
    expect(linkify("javascript:https://example.com")).toEqual([
      text("javascript:"),
      link("https://example.com", "https://example.com/"),
    ]);
  });

  it("does not link an address with credentials", () => {
    expect(linkify("https://user:pass@example.com/")).toEqual([
      text("https://user:pass@example.com/"),
    ]);
    expect(linkify("https://user@example.com/")).toEqual([text("https://user@example.com/")]);
  });

  it("does not link a bare scheme or an empty host", () => {
    expect(linkify("https:// and http://")).toEqual([text("https:// and http://")]);
  });

  it("links at most 2048 characters", () => {
    const fits = "https://example.com/" + "a".repeat(2048 - 20);
    expect(fits.length).toBe(2048);
    expect(linkify(fits)).toEqual([link(fits)]);
    const tooLong = fits + "a";
    expect(linkify(tooLong)).toEqual([text(tooLong)]);
  });

  it("stays fast on very long runs and repeated scheme starts", () => {
    const start = Date.now();
    const repeated = "https://".repeat(5000);
    const run = "a".repeat(200_000);
    expect(
      linkify(repeated)
        .map((t) => t.text)
        .join(""),
    ).toBe(repeated);
    expect(linkify(run)).toEqual([text(run)]);
    expect(linkify(`https://${run}`)).toEqual([text(`https://${run}`)]);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("round-trips: token text joined equals the input", () => {
    const inputs = [
      "a https://example.com/x), b <script>https://e.com</script> c",
      "https://example.com/a\nhttps://example.com/b\t.",
      "\u{1F600} https://example.com/\u{1F600}",
    ];
    for (const input of inputs)
      expect(
        linkify(input)
          .map((t) => t.text)
          .join(""),
      ).toBe(input);
  });

  it("keeps markup around a link as text", () => {
    expect(linkify('<a href="https://example.com/x">y</a>')).toEqual([
      text('<a href="'),
      link("https://example.com/x"),
      text('">y</a>'),
    ]);
  });
});
