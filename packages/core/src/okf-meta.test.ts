import { describe, expect, it } from "vitest";

import {
  MAX_DEPTH,
  MAX_ITEMS,
  MAX_KEY,
  MAX_NODES,
  MAX_TEXT,
  MAX_UNKNOWN,
  buildNotices,
  buildOkfMeta,
  cleanText,
  displayText,
  parseDateText,
  parseOkfDate,
  parseRefs,
  safeExternalUrl,
  shortText,
  staleness,
  statusNotice,
  stripInvisible,
  toDisplayValue,
  type DisplayValue,
  type OkfColumns,
} from "./okf-meta";

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const NONE: OkfColumns = { type: null, tags: [], status: null, description: null };
const cols = (over: Partial<OkfColumns> = {}): OkfColumns => ({ ...NONE, ...over });
const at = (iso: string): Date => new Date(iso);

describe("cleanText", () => {
  it("keeps ordinary text, including other scripts and emoji", () => {
    expect(cleanText("Plain text").text).toBe("Plain text");
    expect(cleanText("Zażółć gęślą jaźń 日本語 🚀").text).toBe("Zażółć gęślą jaźń 日本語 🚀");
  });

  it("removes NUL, other control characters and DEL", () => {
    const dirty = `a${ch(0)}b${ch(1)}c${ch(0x1b)}d${ch(0x7f)}e${ch(0x85)}f`;
    // U+0085 (next line) is a line break, so it becomes a space
    expect(cleanText(dirty).text).toBe("abcde f");
  });

  it("removes direction overrides and isolates (RTL spoofing) and zero-width marks", () => {
    const spoof = `gpj.${ch(0x202e)}txt${ch(0x2066)}${ch(0x2067)}${ch(0x2069)}${ch(0x200b)}${ch(0xfeff)}${ch(0x200e)}${ch(0x200f)}${ch(0x61c)}`;
    expect(cleanText(spoof).text).toBe("gpj.txt");
  });

  it("keeps a genuine right-to-left script", () => {
    expect(cleanText("שלום עולם").text).toBe("שלום עולם");
  });

  it("collapses whitespace in one-line mode and keeps line breaks in multi-line mode", () => {
    expect(cleanText("a \n\t b\r\nc").text).toBe("a b c");
    expect(cleanText("a  \r\nb\n\n\n\nc", 100, true).text).toBe("a\nb\n\nc");
    expect(cleanText(`a${ch(0x2028)}b${ch(0x2029)}c`, 100, true).text).toBe("a\nb\nc");
  });

  it("replaces a lone surrogate", () => {
    expect(cleanText(`a${ch(0xd800)}b`).text).toBe(`a${ch(0xfffd)}b`);
  });

  it("cuts at the limit by code points, never through a surrogate pair", () => {
    const result = cleanText("🚀".repeat(10), 3);
    expect(result).toEqual({ text: "🚀🚀🚀", truncated: true });
    expect(cleanText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  it("inspects only a bounded prefix of a huge string, quickly", () => {
    const start = Date.now();
    const result = cleanText("x".repeat(5_000_000), MAX_TEXT);
    expect(result.text).toHaveLength(MAX_TEXT);
    expect(result.truncated).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("copes with a string of nothing but invisible characters", () => {
    expect(cleanText(ch(0).repeat(100_000))).toEqual({ text: "", truncated: true });
  });

  it("shortText marks a cut with an ellipsis", () => {
    expect(shortText("abcdef", 3)).toBe("abc…");
    expect(shortText("abc", 3)).toBe("abc");
  });
});

describe("safeExternalUrl", () => {
  it("accepts http and https URLs and returns the normalized form", () => {
    expect(safeExternalUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeExternalUrl("  http://Example.com  ")).toBe("http://example.com/");
    expect(safeExternalUrl("HTTPS://example.com")).toBe("https://example.com/");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "mailto:a@example.com",
    "//example.com/x",
    "/docs/a.md",
    "../a.md",
    "docs/a.md",
    "example.com",
    "https://",
    "https://user:pass@example.com/",
    "https://user@example.com/",
    "https://exa mple.com/",
    "https://example.com/a b",
    "https://exa\nmple.com",
    "https://example.com\\@evil.com",
    `https://example.com/${ch(0x202e)}x`,
    `https://example.com/${ch(0)}`,
    "",
    "   ",
  ])("rejects %j", (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });

  it("rejects an over-long URL", () => {
    expect(safeExternalUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
    expect(safeExternalUrl(`https://example.com/${"a".repeat(2000)}`)).not.toBeNull();
  });
});

describe("parseDateText", () => {
  it("parses a date alone as midnight UTC", () => {
    expect(parseDateText("2026-03-14")).toEqual({
      date: at("2026-03-14T00:00:00Z"),
      dateOnly: true,
    });
  });

  it("parses date-times: no offset means UTC", () => {
    expect(parseDateText("2026-03-14T09:30:00Z")?.date).toEqual(at("2026-03-14T09:30:00Z"));
    expect(parseDateText("2026-03-14T09:30")?.date).toEqual(at("2026-03-14T09:30:00Z"));
    expect(parseDateText("2026-03-14 09:30:15")?.date).toEqual(at("2026-03-14T09:30:15Z"));
    expect(parseDateText("2026-03-14T09:30:15.5Z")?.date).toEqual(at("2026-03-14T09:30:15.500Z"));
    expect(parseDateText("2026-03-14T09:30:15,123456Z")?.date).toEqual(
      at("2026-03-14T09:30:15.123Z"),
    );
    expect(parseDateText("2026-03-14t09:30z")?.dateOnly).toBe(false);
    expect(parseDateText("2026-03-14T09:30:00Z")?.dateOnly).toBe(false);
  });

  it("applies offsets", () => {
    expect(parseDateText("2026-03-14T09:30:00+02:00")?.date).toEqual(at("2026-03-14T07:30:00Z"));
    expect(parseDateText("2026-03-14T09:30:00-0530")?.date).toEqual(at("2026-03-14T15:00:00Z"));
    expect(parseDateText("2026-03-14T09:30:00+02")?.date).toEqual(at("2026-03-14T07:30:00Z"));
    expect(parseDateText("2026-03-14T00:30:00+01:00")?.date).toEqual(at("2026-03-13T23:30:00Z"));
  });

  it("knows leap days", () => {
    expect(parseDateText("2024-02-29")).not.toBeNull();
    expect(parseDateText("2000-02-29")).not.toBeNull();
    expect(parseDateText("2026-02-29")).toBeNull();
    expect(parseDateText("1900-02-29")).toBeNull();
    expect(parseDateText("2100-02-29")).toBeNull();
  });

  it("handles very old and far future years without the 1900 shift", () => {
    expect(parseDateText("0050-06-01")?.date.getUTCFullYear()).toBe(50);
    expect(parseDateText("0001-01-01")?.date.getUTCFullYear()).toBe(1);
    expect(parseDateText("9999-12-31")?.date.getUTCFullYear()).toBe(9999);
    expect(parseDateText("0000-01-01")).toBeNull();
  });

  it.each([
    "",
    "soon",
    "2026",
    "2026-3-14",
    "26-03-14",
    "14/03/2026",
    "March 14, 2026",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-03-14T24:00",
    "2026-03-14T23:60",
    "2026-03-14T23:59:60",
    "2026-03-14T09:30+24:00",
    "2026-03-14T09:30+01:60",
    "2026-03-14T09",
    "2026-03-14Tfoo",
    "2026-03-14T09:30:00ZZ",
    "2026-03-14 and more",
    "+002026-03-14",
    "1".repeat(100),
  ])("rejects %j", (text) => {
    expect(parseDateText(text)).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDateText("  2026-03-14  ")).not.toBeNull();
    expect(parseDateText("2026-03-14\n")).not.toBeNull();
  });
});

describe("parseOkfDate", () => {
  it("returns null for an absent, null or blank value", () => {
    expect(parseOkfDate(undefined)).toBeNull();
    expect(parseOkfDate(null)).toBeNull();
    expect(parseOkfDate("")).toBeNull();
    expect(parseOkfDate("   ")).toBeNull();
  });

  it("returns a valid date with its raw text", () => {
    expect(parseOkfDate("2026-03-14")).toEqual({
      raw: "2026-03-14",
      valid: true,
      date: at("2026-03-14T00:00:00Z"),
      dateOnly: true,
    });
  });

  it.each([
    ["soon"],
    [2026],
    [20260314],
    [true],
    [["2026-03-14"]],
    [{ at: "2026-03-14" }],
    ["2026-02-30"],
  ])("marks %j invalid but keeps what was written", (value) => {
    const result = parseOkfDate(value);
    expect(result?.valid).toBe(false);
    expect(result?.date).toBeNull();
    expect(result?.raw).not.toBe("");
  });

  it("cleans the raw text of a hostile value", () => {
    const result = parseOkfDate(`<b>x</b>${ch(0x202e)}${"y".repeat(500)}`);
    expect(result?.valid).toBe(false);
    expect(result?.raw).not.toContain(ch(0x202e));
    expect(result?.raw.length).toBeLessThanOrEqual(82);
  });
});

describe("staleness", () => {
  const meta = (value: unknown) => ({ staleAfter: parseOkfDate(value) });

  it("is none without a stale_after (and for an unusable now)", () => {
    expect(staleness({ staleAfter: null }, at("2026-10-10T00:00:00Z"))).toEqual({ state: "none" });
    expect(staleness(meta("2025-01-01"), new Date(Number.NaN))).toEqual({ state: "none" });
  });

  it("is stale when the date is in the past, with the days overdue", () => {
    const result = staleness(meta("2026-10-01"), at("2026-10-10T12:00:00Z"));
    expect(result).toMatchObject({ state: "stale", daysOverdue: 9 });
    if (result.state === "stale") expect(result.due.raw).toBe("2026-10-01");
  });

  it("is upcoming when the date is in the future, with the days left", () => {
    expect(staleness(meta("2026-10-20"), at("2026-10-10T12:00:00Z"))).toMatchObject({
      state: "upcoming",
      daysUntil: 10,
    });
    expect(staleness(meta("2999-01-01"), at("2026-10-10T12:00:00Z"))).toMatchObject({
      state: "upcoming",
    });
  });

  it("treats a date alone as valid through the end of that UTC day", () => {
    expect(staleness(meta("2026-10-10"), at("2026-10-10T00:00:00Z")).state).toBe("upcoming");
    expect(staleness(meta("2026-10-10"), at("2026-10-10T23:59:59.999Z"))).toMatchObject({
      state: "upcoming",
      daysUntil: 0,
    });
    // exactly the start of the next day is not yet "after" it
    expect(staleness(meta("2026-10-10"), at("2026-10-11T00:00:00.000Z")).state).toBe("upcoming");
    expect(staleness(meta("2026-10-10"), at("2026-10-11T00:00:00.001Z"))).toMatchObject({
      state: "stale",
      daysOverdue: 1,
    });
  });

  it("is a time zone boundary matter only in UTC, whatever the offset written", () => {
    // 2026-10-10T23:30-05:00 is 2026-10-11T04:30Z
    expect(staleness(meta("2026-10-10T23:30:00-05:00"), at("2026-10-11T04:29:59Z")).state).toBe(
      "upcoming",
    );
    expect(staleness(meta("2026-10-10T23:30:00-05:00"), at("2026-10-11T04:30:01Z"))).toMatchObject({
      state: "stale",
      daysOverdue: 0,
    });
  });

  it("is stale for a time earlier today (0 days overdue) and upcoming for a later time today", () => {
    expect(staleness(meta("2026-10-10T08:00:00Z"), at("2026-10-10T12:00:00Z"))).toMatchObject({
      state: "stale",
      daysOverdue: 0,
    });
    expect(staleness(meta("2026-10-10T18:00:00Z"), at("2026-10-10T12:00:00Z"))).toMatchObject({
      state: "upcoming",
      daysUntil: 0,
    });
  });

  it("counts across a leap day, a year end and very old dates", () => {
    expect(staleness(meta("2024-02-28"), at("2024-03-01T10:00:00Z"))).toMatchObject({
      state: "stale",
      daysOverdue: 2,
    });
    expect(staleness(meta("2025-12-31"), at("2026-01-02T00:00:00Z"))).toMatchObject({
      state: "stale",
      daysOverdue: 2,
    });
    expect(staleness(meta("1066-10-14"), at("2026-10-10T00:00:00Z"))).toMatchObject({
      state: "stale",
    });
    expect(staleness(meta("0001-01-01"), at("2026-10-10T00:00:00Z"))).toMatchObject({
      state: "stale",
    });
    expect(staleness(meta("9999-12-31"), at("2026-10-10T00:00:00Z"))).toMatchObject({
      state: "upcoming",
    });
  });

  it("is invalid for an unparsable value, which is never stale", () => {
    expect(staleness(meta("next week"), at("2026-10-10T00:00:00Z"))).toEqual({
      state: "invalid",
      raw: "next week",
    });
    expect(staleness(meta(2020), at("2026-10-10T00:00:00Z")).state).toBe("invalid");
  });
});

describe("statusNotice", () => {
  it("recognizes deprecated and draft ignoring case and spacing", () => {
    expect(statusNotice("deprecated")).toBe("deprecated");
    expect(statusNotice("Deprecated")).toBe("deprecated");
    expect(statusNotice("  DRAFT ")).toBe("draft");
    expect(statusNotice("draft")).toBe("draft");
  });

  it.each(["active", "stable", "deprecated-soon", "drafting", "", "undraft", "not deprecated"])(
    "gives no notice for %j",
    (status) => {
      expect(statusNotice(status)).toBeNull();
    },
  );

  it("gives no notice for a missing status", () => {
    expect(statusNotice(null)).toBeNull();
    expect(statusNotice(undefined)).toBeNull();
  });
});

describe("buildNotices", () => {
  const now = at("2026-10-10T12:00:00Z");

  it("is empty for an active, fresh document", () => {
    const meta = buildOkfMeta({ stale_after: "2027-01-01" }, cols({ type: "x", status: "active" }));
    expect(buildNotices(meta, now)).toEqual([]);
  });

  it("stacks a status notice and a stale warning, status first", () => {
    const meta = buildOkfMeta({ stale_after: "2025-01-01" }, cols({ status: "Deprecated" }));
    const notices = buildNotices(meta, now);
    expect(notices.map((n) => n.kind)).toEqual(["deprecated", "stale"]);
    expect(notices[1]).toMatchObject({ kind: "stale", daysOverdue: 647 });
  });

  it("gives a draft notice and none for an invalid date", () => {
    const meta = buildOkfMeta({ stale_after: "whenever" }, cols({ status: "draft" }));
    expect(buildNotices(meta, now).map((n) => n.kind)).toEqual(["draft"]);
  });
});

describe("toDisplayValue and displayText", () => {
  const text = (v: DisplayValue) => (v.kind === "text" ? v.text : null);

  it("describes scalars", () => {
    expect(toDisplayValue("hi")).toMatchObject({ kind: "text", text: "hi", scalar: "string" });
    expect(toDisplayValue(3)).toMatchObject({ text: "3", scalar: "number" });
    expect(toDisplayValue(false)).toMatchObject({ text: "false", scalar: "boolean" });
    expect(toDisplayValue(null)).toMatchObject({ text: "null", scalar: "null" });
    expect(toDisplayValue("")).toMatchObject({ kind: "text", text: "" });
  });

  it("keeps markup-looking text as text", () => {
    expect(text(toDisplayValue("<img src=x onerror=alert(1)> **b**"))).toBe(
      "<img src=x onerror=alert(1)> **b**",
    );
  });

  it("truncates a long string", () => {
    const v = toDisplayValue("a".repeat(5000));
    expect(v).toMatchObject({ kind: "text", truncated: true });
    expect(text(v)).toHaveLength(MAX_TEXT);
  });

  it("describes nested lists and mappings", () => {
    const v = toDisplayValue({ a: [1, "b"], c: { d: true } });
    expect(v).toMatchObject({
      kind: "map",
      omitted: 0,
      entries: [
        { key: "a", value: { kind: "list", items: [{ text: "1" }, { text: "b" }] } },
        { key: "c", value: { kind: "map", entries: [{ key: "d", value: { text: "true" } }] } },
      ],
    });
  });

  it("caps list and mapping width and reports what was left out", () => {
    const list = toDisplayValue(Array.from({ length: 1000 }, (_, i) => i));
    expect(list).toMatchObject({ kind: "list", omitted: 1000 - MAX_ITEMS });
    expect(list.kind === "list" && list.items.length).toBe(MAX_ITEMS);
    const map = toDisplayValue(
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
    );
    expect(map).toMatchObject({ kind: "map", omitted: 100 - MAX_ITEMS });
  });

  it("caps depth with a size summary instead of recursing", () => {
    let nested: unknown = { x: 1, y: 2 };
    for (let i = 0; i < 50; i += 1) nested = { next: nested };
    let v: DisplayValue = toDisplayValue(nested);
    let levels = 0;
    while (v.kind === "map") {
      levels += 1;
      v = v.entries[0]?.value ?? { kind: "deep", summary: "?" };
    }
    expect(levels).toBe(MAX_DEPTH);
    expect(v).toEqual({ kind: "deep", summary: "1 field" });
    expect(toDisplayValue([[[[[1, 2, 3]]]]])).toMatchObject({ kind: "list" });
  });

  it("caps the total size of a wide and deep value", () => {
    const wide = Array.from({ length: MAX_ITEMS }, () =>
      Array.from({ length: MAX_ITEMS }, () => Array.from({ length: MAX_ITEMS }, () => "v")),
    );
    const count = (v: DisplayValue): number =>
      v.kind === "list"
        ? 1 + v.items.reduce((n, i) => n + count(i), 0)
        : v.kind === "map"
          ? 1 + v.entries.reduce((n, e) => n + count(e.value), 0)
          : 1;
    expect(count(toDisplayValue(wide))).toBeLessThanOrEqual(MAX_NODES + MAX_ITEMS);
  });

  it("copes with a 100,000 item array and a 10,000 key object quickly", () => {
    const start = Date.now();
    toDisplayValue(Array.from({ length: 100_000 }, (_, i) => ({ i })));
    toDisplayValue(Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, [i]])));
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("keeps a __proto__ key as data and cleans keys", () => {
    const hostile = JSON.parse(`{"__proto__": {"polluted": true}, "${ch(0x202e)}k\\u0000ey": 1}`);
    const v = toDisplayValue(hostile);
    expect(v).toMatchObject({ kind: "map" });
    if (v.kind !== "map") return;
    expect(v.entries.map((e) => e.key)).toEqual(["__proto__", "key"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never throws on odd runtime values", () => {
    expect(() => toDisplayValue(() => 1)).not.toThrow();
    expect(() => toDisplayValue(Symbol("s"))).not.toThrow();
    expect(() => toDisplayValue(undefined)).not.toThrow();
    expect(() => toDisplayValue(10n)).not.toThrow();
  });

  it("flattens to one line of text", () => {
    expect(displayText({ a: [1, 2], b: "x" })).toBe("{a: [1, 2], b: x}");
    expect(displayText("a\nb")).toBe("a b");
    expect(displayText("z".repeat(500), 10)).toBe(`${"z".repeat(10)}…`);
    expect(displayText([])).toBe("[]");
  });
});

describe("parseRefs", () => {
  it("links an http(s) string and shows any other string as plain text", () => {
    expect(parseRefs("https://example.com/a")).toEqual({
      items: [{ label: "https://example.com/a", href: "https://example.com/a" }],
      omitted: 0,
    });
    expect(parseRefs("docs/a.md").items).toEqual([{ label: "docs/a.md", href: null }]);
    expect(parseRefs("javascript:alert(1)").items).toEqual([
      { label: "javascript:alert(1)", href: null },
    ]);
  });

  it("accepts a list of strings and objects", () => {
    const refs = parseRefs([
      "https://a.example/",
      { title: "Spec", url: "https://b.example/spec" },
      { name: "Local", path: "docs/x.md" },
      { href: "data:text/html,x" },
      { unrelated: 1, other: [2] },
      42,
      true,
      null,
      "",
      [],
      {},
    ]);
    expect(refs.items).toEqual([
      { label: "https://a.example/", href: "https://a.example/" },
      { label: "Spec", href: "https://b.example/spec" },
      { label: "Local", href: null },
      { label: "data:text/html,x", href: null },
      { label: "{unrelated: 1, other: [2]}", href: null },
      { label: "42", href: null },
      { label: "true", href: null },
    ]);
  });

  it("accepts a single object", () => {
    expect(parseRefs({ label: "One", link: "http://x.example" }).items).toEqual([
      { label: "One", href: "http://x.example/" },
    ]);
  });

  it("is empty for nothing", () => {
    for (const v of [undefined, null, "", "  ", [], {}, [[]], [null]]) {
      expect(parseRefs(v).items).toEqual([]);
    }
  });

  it("caps the list and counts the rest", () => {
    const refs = parseRefs(Array.from({ length: 100 }, (_, i) => `https://e.example/${i}`));
    expect(refs.items).toHaveLength(MAX_ITEMS);
    expect(refs.omitted).toBe(100 - MAX_ITEMS);
  });

  it("truncates a huge label and refuses to link a huge URL", () => {
    const refs = parseRefs(`https://example.com/${"a".repeat(100_000)}`);
    expect(refs.items[0]?.href).toBeNull();
    expect(refs.items[0]?.label.length).toBeLessThanOrEqual(301);
  });
});

describe("buildOkfMeta, filter values", () => {
  const ZWSP = String.fromCharCode(0x200b);

  it("keeps the stored value for the filter and the cleaned text for display", () => {
    const type = `  Run${ZWSP}book  x `;
    const status = "in  review";
    const tags = ["a  b", "x".repeat(150)];
    const meta = buildOkfMeta({}, cols({ type, status, tags }));
    expect(meta.type).toBe("Runbook x");
    expect(meta.typeFilter).toBe(type);
    expect(meta.status).toBe("in review");
    expect(meta.statusFilter).toBe(status);
    expect(meta.tags[0]).toBe("a b");
    expect(meta.tags[1]?.endsWith("…")).toBe(true);
    expect(meta.tagFilters).toEqual(tags);
  });

  it("has no filter value when the stored value cannot be one", () => {
    const meta = buildOkfMeta({}, cols({ type: "T".repeat(257), tags: ["ok", "t".repeat(300)] }));
    expect(meta.type).toBe("T".repeat(257));
    expect(meta.typeFilter).toBeNull();
    expect(meta.tagFilters).toEqual(["ok", null]);
    expect(buildOkfMeta({}, NONE).typeFilter).toBeNull();
  });

  it("keeps tags and tag filters parallel when a tag cleans to nothing", () => {
    const meta = buildOkfMeta({}, cols({ tags: [ZWSP, "real", "  "] }));
    expect(meta.tags).toEqual(["real"]);
    expect(meta.tagFilters).toEqual(["real"]);
  });
});

describe("buildOkfMeta", () => {
  it("builds a type-only document: just the type, nothing else", () => {
    const meta = buildOkfMeta({ type: "Note" }, cols({ type: "Note" }));
    expect(meta).toEqual({
      type: "Note",
      status: null,
      tags: [],
      typeFilter: "Note",
      statusFilter: null,
      tagFilters: [],
      tagsOmitted: 0,
      description: null,
      resource: { items: [], omitted: 0 },
      sources: { items: [], omitted: 0 },
      generated: null,
      verified: null,
      staleAfter: null,
      unknown: [],
      unknownOmitted: 0,
      hasContent: true,
    });
  });

  it("has no content for a document with nothing (an untyped note)", () => {
    expect(buildOkfMeta({}, NONE).hasContent).toBe(false);
    expect(buildOkfMeta(null, NONE).hasContent).toBe(false);
    expect(buildOkfMeta(undefined, NONE).hasContent).toBe(false);
    expect(buildOkfMeta([1, 2], NONE).hasContent).toBe(false);
    expect(buildOkfMeta("text", NONE).hasContent).toBe(false);
  });

  it("keeps the type verbatim: case and spacing are not normalized", () => {
    expect(buildOkfMeta({ type: "metric" }, cols({ type: "metric" })).type).toBe("metric");
    expect(buildOkfMeta({ type: "Metric" }, cols({ type: "Metric" })).type).toBe("Metric");
    expect(buildOkfMeta({ type: "My  Odd Type" }, cols({ type: "My  Odd Type" })).type).toBe(
      "My Odd Type",
    );
    expect(buildOkfMeta({ type: "Ünïcode Тип 🚀" }, cols({ type: "Ünïcode Тип 🚀" })).type).toBe(
      "Ünïcode Тип 🚀",
    );
  });

  it("builds a fully described document", () => {
    const meta = buildOkfMeta(
      {
        type: "Runbook",
        tags: ["a", "b"],
        status: "active",
        description: "Does things.",
        resource: "https://example.com/r",
        sources: ["https://example.com/s1", { title: "S2", url: "https://example.com/s2" }],
        generated: "2026-01-02",
        verified: "2026-02-03T04:05:06Z",
        stale_after: "2027-01-01",
        title: "T",
        okf_version: "0.2",
        owner_team: "platform",
      },
      cols({ type: "Runbook", tags: ["a", "b"], status: "active", description: "Does things." }),
    );
    expect(meta.type).toBe("Runbook");
    expect(meta.tags).toEqual(["a", "b"]);
    expect(meta.status).toBe("active");
    expect(meta.description).toBe("Does things.");
    expect(meta.resource.items).toEqual([
      { label: "https://example.com/r", href: "https://example.com/r" },
    ]);
    expect(meta.sources.items.map((s) => s.label)).toEqual(["https://example.com/s1", "S2"]);
    expect(meta.generated?.valid).toBe(true);
    expect(meta.verified?.dateOnly).toBe(false);
    expect(meta.staleAfter?.raw).toBe("2027-01-01");
    // title and okf_version are known; only the producer-defined key is left over
    expect(meta.unknown.map((u) => u.key)).toEqual(["owner_team"]);
  });

  it("lists unknown keys of every shape in the stored order", () => {
    const meta = buildOkfMeta(
      {
        type: "Note",
        owner_team: "platform",
        nested: { a: { b: 1 } },
        list: [1, "two", false, null],
        count: 7,
        flag: true,
        nothing: null,
        long: "x".repeat(2000),
        markup: "<script>alert(1)</script>",
        "weird key <b>": "v",
      },
      cols({ type: "Note" }),
    );
    expect(meta.unknown.map((u) => u.key)).toEqual([
      "owner_team",
      "nested",
      "list",
      "count",
      "flag",
      "nothing",
      "long",
      "markup",
      "weird key <b>",
    ]);
    const byKey = Object.fromEntries(meta.unknown.map((u) => [u.key, u.value]));
    expect(byKey.nested).toMatchObject({ kind: "map" });
    expect(byKey.list).toMatchObject({ kind: "list" });
    expect(byKey.count).toMatchObject({ text: "7", scalar: "number" });
    expect(byKey.flag).toMatchObject({ text: "true" });
    expect(byKey.nothing).toMatchObject({ scalar: "null" });
    expect(byKey.long).toMatchObject({ truncated: true });
    expect(byKey.markup).toMatchObject({ text: "<script>alert(1)</script>" });
  });

  it("lists a known key with an unusable shape among the unknown keys", () => {
    const meta = buildOkfMeta(
      { type: "Note", status: ["a", "b"], description: { x: 1 }, tags: [1, "ok"], title: 5 },
      cols({ type: "Note", tags: ["ok"] }),
    );
    expect(meta.unknown.map((u) => u.key)).toEqual(["status", "description", "tags", "title"]);
    expect(meta.status).toBeNull();
    expect(meta.description).toBeNull();
  });

  it("shows a non-string type among the other fields; a blank or null one shows nothing", () => {
    expect(buildOkfMeta({ type: 3 }, NONE).unknown.map((u) => u.key)).toEqual(["type"]);
    expect(buildOkfMeta({ type: ["a"] }, NONE).unknown.map((u) => u.key)).toEqual(["type"]);
    expect(buildOkfMeta({ type: "" }, NONE).unknown).toEqual([]);
    expect(buildOkfMeta({ type: null }, NONE).unknown).toEqual([]);
    expect(buildOkfMeta({ type: "" }, NONE).hasContent).toBe(false);
  });

  it("does not list an empty tags key as unknown", () => {
    expect(buildOkfMeta({ tags: [] }, NONE).unknown).toEqual([]);
    expect(buildOkfMeta({ tags: null }, NONE).unknown).toEqual([]);
    expect(buildOkfMeta({ tags: "single" }, cols({ tags: ["single"] })).unknown).toEqual([]);
  });

  it("flags invalid dates and keeps the raw text", () => {
    const meta = buildOkfMeta(
      { generated: "yesterday", verified: 2020, stale_after: "2026-02-30" },
      NONE,
    );
    expect(meta.generated).toMatchObject({ valid: false, raw: "yesterday" });
    expect(meta.verified).toMatchObject({ valid: false, raw: "2020" });
    expect(meta.staleAfter).toMatchObject({ valid: false, raw: "2026-02-30" });
    expect(meta.unknown).toEqual([]);
    expect(meta.hasContent).toBe(true);
  });

  it("omits empty fields: blank strings, null and empty lists show nothing", () => {
    const meta = buildOkfMeta(
      { type: "Note", description: "  ", resource: "", sources: [], generated: "", verified: null },
      cols({ type: "Note" }),
    );
    expect(meta.description).toBeNull();
    expect(meta.resource.items).toEqual([]);
    expect(meta.sources.items).toEqual([]);
    expect(meta.generated).toBeNull();
    expect(meta.verified).toBeNull();
    expect(meta.unknown).toEqual([]);
  });

  it("caps the unknown keys and reports the rest", () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const meta = buildOkfMeta(many, NONE);
    expect(meta.unknown).toHaveLength(MAX_UNKNOWN);
    expect(meta.unknownOmitted).toBe(500 - MAX_UNKNOWN);
  });

  it("caps the tags and cleans each one", () => {
    const tags = Array.from({ length: 200 }, (_, i) => `tag-${i}`);
    const meta = buildOkfMeta({ tags }, cols({ tags }));
    expect(meta.tags).toHaveLength(MAX_UNKNOWN);
    expect(meta.tagsOmitted).toBe(150);
    const odd = buildOkfMeta({}, cols({ tags: [`a${ch(0x202e)}b`, "", "x".repeat(1000)] }));
    expect(odd.tags[0]).toBe("ab");
    expect(odd.tags).toHaveLength(2);
    expect(odd.tags[1]).toHaveLength(MAX_KEY + 1);
  });

  it("is safe with prototype-polluting and non-string-looking keys", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 2}}, "toString": "x", "0": "zero", "type": "Note", "hasOwnProperty": 5}',
    ) as Record<string, unknown>;
    const meta = buildOkfMeta(hostile, cols({ type: "Note" }));
    expect(meta.unknown.map((u) => u.key).sort()).toEqual(
      ["0", "__proto__", "constructor", "hasOwnProperty", "toString"].sort(),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("is not fooled by an inherited property: only own keys count", () => {
    const inherited = Object.create({
      type: "Inherited",
      status: "draft",
      resource: "https://x.example",
    });
    const meta = buildOkfMeta(inherited, NONE);
    expect(meta.type).toBeNull();
    expect(meta.status).toBeNull();
    expect(meta.resource.items).toEqual([]);
  });

  it("cleans every displayed string of control characters and direction overrides", () => {
    const meta = buildOkfMeta(
      { description: `d${ch(0)}${ch(0x202e)}x`, owner: `o${ch(0x1b)}${ch(0x2067)}k` },
      cols({ type: `t${ch(0x202e)}`, status: `s${ch(0)}`, description: `d${ch(0)}${ch(0x202e)}x` }),
    );
    expect(meta.type).toBe("t");
    expect(meta.status).toBe("s");
    expect(meta.description).toBe("dx");
    expect(JSON.stringify(meta.unknown)).not.toContain("202e");
    expect(meta.unknown[0]?.value).toMatchObject({ text: "ok" });
  });

  it("falls back to the frontmatter string when the column is empty", () => {
    expect(buildOkfMeta({ status: "draft", description: "From fm" }, NONE)).toMatchObject({
      status: "draft",
      description: "From fm",
    });
  });

  it("keeps a multi-line description's line breaks", () => {
    expect(buildOkfMeta({ description: "a\n\nb" }, NONE).description).toBe("a\n\nb");
  });

  it("copes with a huge frontmatter object without throwing", () => {
    const frontmatter: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) frontmatter[`key${i}`] = { a: [i, { b: "c".repeat(50) }] };
    const start = Date.now();
    const meta = buildOkfMeta(frontmatter, cols({ type: "T" }));
    expect(meta.unknown).toHaveLength(MAX_UNKNOWN);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("stripInvisible", () => {
  it("keeps indentation, blank lines and tabs", () => {
    const text = "  indented\n\n\tcode\n    four spaces  \nend";
    expect(stripInvisible(text)).toBe(text);
  });

  it("normalizes every kind of line break to a line feed", () => {
    expect(stripInvisible("a\r\nb\rc\u2028d\u2029e\u0085f")).toBe("a\nb\nc\nd\ne\nf");
  });

  it("removes controls and direction-changing or invisible characters", () => {
    const hostile = "a\u0000b\u0007c\u007fd\u0085e\u061cf\u200bg\u200eh\u202ei\u2066j\ufeffk";
    expect(stripInvisible(hostile).replace(/\n/g, "")).toBe("abcdefghijk");
  });

  it("replaces a lone surrogate and keeps a pair", () => {
    expect(stripInvisible("a\ud800b")).toBe("a\ufffdb");
    expect(stripInvisible("😀")).toBe("😀");
  });

  it("leaves ordinary text, Markdown and unicode alone", () => {
    const text = "# Title\n\n- item `code` **bold** [link](./x.md)\n\nDeutsch: Größe, 日本語.";
    expect(stripInvisible(text)).toBe(text);
  });
});
