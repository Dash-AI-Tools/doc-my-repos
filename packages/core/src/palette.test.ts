import { describe, expect, it } from "vitest";

import {
  PALETTE_DEFAULT_LIMIT,
  PALETTE_MAX_LIMIT,
  isSafeAppHref,
  paletteLimit,
  paletteRequestUrl,
  paletteResponse,
  parsePaletteRequest,
  parsePaletteResponse,
  toPaletteHit,
} from "./palette";
import type { ResultItemData } from "./search-view";

const params = (query: string) => new URLSearchParams(query);

const item: ResultItemData = {
  key: "1:docs/a.md",
  title: "A",
  href: "/acme/api/docs/a#sec",
  repoLabel: "acme/api",
  repoHref: "/acme/api",
  path: "docs/a.md",
  section: "Sec",
  snippet: "x",
  isPrivate: true,
  type: "Runbook",
  status: "draft",
  tags: ["t"],
};

const hit = {
  key: "1:docs/a.md",
  title: "A",
  href: "/acme/api/docs/a",
  repoLabel: "acme/api",
  path: "docs/a.md",
  section: null,
  snippet: "",
  isPrivate: false,
};

describe("paletteLimit", () => {
  it("defaults to 8 and clamps to 1..10", () => {
    expect(paletteLimit(null)).toBe(PALETTE_DEFAULT_LIMIT);
    expect(paletteLimit(undefined)).toBe(8);
    expect(paletteLimit("")).toBe(8);
    expect(paletteLimit("abc")).toBe(8);
    expect(paletteLimit("-3")).toBe(8);
    expect(paletteLimit("2.5")).toBe(8);
    expect(paletteLimit("1e3")).toBe(8);
    expect(paletteLimit("0")).toBe(1);
    expect(paletteLimit("1")).toBe(1);
    expect(paletteLimit("10")).toBe(PALETTE_MAX_LIMIT);
    expect(paletteLimit("11")).toBe(10);
    expect(paletteLimit("999999")).toBe(10);
    expect(paletteLimit("99999999999")).toBe(8);
  });
});

describe("parsePaletteRequest", () => {
  it("reads q, limit and repo, and ignores every other filter and paging", () => {
    expect(
      parsePaletteRequest(
        params("q=deploy&limit=3&repo=acme/api&type=Runbook&tag=x&status=draft&page=4"),
      ),
    ).toEqual({
      q: "deploy",
      repos: ["acme/api"],
      types: [],
      tags: [],
      statuses: [],
      page: 1,
      limit: 3,
    });
  });

  it("normalizes the query like the search page does", () => {
    expect(parsePaletteRequest(params("q=%20%20a%00%20%20b%20")).q).toBe("a b");
    expect(parsePaletteRequest(params(`q=${"x".repeat(1000)}`)).q).toHaveLength(256);
    expect(parsePaletteRequest(params("")).q).toBe("");
    expect(parsePaletteRequest(params("q=a&q=b")).q).toBe("a");
  });

  it("never throws on hostile input", () => {
    for (const query of ["q=%", "q=%E0%A4%A", "repo=%00&q=a", "limit=%ff", "q=&repo=&limit="]) {
      expect(() => parsePaletteRequest(params(query))).not.toThrow();
    }
  });
});

describe("paletteRequestUrl", () => {
  it("encodes the query", () => {
    expect(paletteRequestUrl("a b&c=d")).toBe("/api/search?q=a+b%26c%3Dd&limit=8");
    expect(paletteRequestUrl("x", 3)).toBe("/api/search?q=x&limit=3");
  });
});

describe("toPaletteHit and paletteResponse", () => {
  it("keeps only what a row shows", () => {
    expect(toPaletteHit(item)).toEqual({
      key: "1:docs/a.md",
      title: "A",
      href: "/acme/api/docs/a#sec",
      repoLabel: "acme/api",
      path: "docs/a.md",
      section: "Sec",
      snippet: "x",
      isPrivate: true,
    });
  });

  it("links to the full results page for the query", () => {
    const state = parsePaletteRequest(params("q=a%20b"));
    expect(paletteResponse(state, 5, [])).toEqual({
      q: "a b",
      total: 5,
      hits: [],
      seeAll: "/search?q=a%20b",
    });
    expect(paletteResponse(parsePaletteRequest(params("")), 0, []).seeAll).toBe("/search");
  });
});

describe("isSafeAppHref", () => {
  it.each(["/", "/acme/api", "/acme/api/docs/a#sec", "/search?q=a%20b"])("accepts %s", (href) => {
    expect(isSafeAppHref(href)).toBe(true);
  });
  it.each([
    "",
    "//evil.test/x",
    "https://evil.test",
    "javascript:alert(1)",
    "acme/api",
    "/\\evil.test",
    "/a\nb",
    "/a\u0000b",
    "data:text/html,x",
  ])("rejects %j", (href) => {
    expect(isSafeAppHref(href)).toBe(false);
  });
});

describe("parsePaletteResponse", () => {
  it("accepts the documented shape", () => {
    expect(parsePaletteResponse({ q: "a", total: 3, hits: [hit], seeAll: "/search?q=a" })).toEqual({
      total: 3,
      hits: [hit],
    });
    expect(parsePaletteResponse({ total: 0, hits: [] })).toEqual({ total: 0, hits: [] });
  });

  it.each([null, undefined, "x", 3, [], {}, { hits: [] }, { total: "1", hits: [] }])(
    "rejects %j as a whole",
    (value) => {
      expect(parsePaletteResponse(value)).toBeNull();
    },
  );
  it.each([
    { total: -1, hits: [] },
    { total: NaN, hits: [] },
    { total: 1, hits: {} },
  ])("rejects %j", (value) => {
    expect(parsePaletteResponse(value)).toBeNull();
  });

  it("drops malformed rows, rows with unsafe links and duplicate keys", () => {
    const parsed = parsePaletteResponse({
      total: 9,
      hits: [
        hit,
        hit,
        null,
        "x",
        { ...hit, key: "2", title: 3 },
        { ...hit, key: "3", href: "https://evil.test" },
        { ...hit, key: "4", href: "//evil.test" },
        { ...hit, key: "5", isPrivate: "yes" },
        { ...hit, key: "6", section: 7 },
        { ...hit, key: "7", extra: "<script>" },
      ],
    });
    expect(parsed?.hits.map((h) => h.key)).toEqual(["1:docs/a.md", "7"]);
    // unknown fields are not carried over
    expect(Object.keys(parsed?.hits[1] ?? {}).sort()).toEqual(Object.keys(hit).sort());
    expect(parsed?.total).toBe(9);
  });
});
