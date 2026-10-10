import { describe, expect, it } from "vitest";

import { MAX_FILTER_VALUES, MAX_QUERY_CHARS } from "./search";
import {
  buildFilterQuery,
  buildSearchUrl,
  clearFilters,
  computePaging,
  EMPTY_SEARCH_STATE,
  filterCount,
  formFields,
  hasFilters,
  isFilterSelected,
  MAX_PAGE,
  offsetFor,
  parseSearchParams,
  toggleFilter,
  withPage,
  withQuery,
  type SearchState,
} from "./search-params";

const parse = (query: string) => parseSearchParams(new URLSearchParams(query));

function state(partial: Partial<SearchState>): SearchState {
  return { ...EMPTY_SEARCH_STATE, ...partial };
}

describe("parseSearchParams", () => {
  it("reads the query, repeated filters, page and size", () => {
    const parsed = parse(
      "q=rate+limit&repo=acme/api&repo=acme/web&type=Metric&tag=a&tag=b&status=draft&page=3&limit=50",
    );
    expect(parsed).toEqual({
      q: "rate limit",
      repos: ["acme/api", "acme/web"],
      types: ["Metric"],
      tags: ["a", "b"],
      statuses: ["draft"],
      page: 3,
      limit: 50,
    });
  });

  it("returns the empty state for no parameters", () => {
    expect(parse("")).toEqual(EMPTY_SEARCH_STATE);
    expect(parseSearchParams({})).toEqual(EMPTY_SEARCH_STATE);
  });

  it("reads the object Next.js passes to a page (string, array, undefined)", () => {
    expect(
      parseSearchParams({ q: "deploy", repo: ["acme/a", "acme/b"], type: "x", tag: undefined }),
    ).toEqual({ ...EMPTY_SEARCH_STATE, q: "deploy", repos: ["acme/a", "acme/b"], types: ["x"] });
  });

  it("takes the first value of a repeated q, page and limit", () => {
    const parsed = parse("q=first&q=second&page=2&page=5&limit=10&limit=20");
    expect(parsed.q).toBe("first");
    expect(parsed.page).toBe(2);
    expect(parsed.limit).toBe(10);
  });

  it("keeps type, tag and status exactly as authored (case and spacing)", () => {
    const parsed = parse("type=Metric&type=metric&type=%20spaced%20&tag=Finance");
    expect(parsed.types).toEqual([" spaced ", "Metric", "metric"]);
    expect(parsed.tags).toEqual(["Finance"]);
  });

  it("sorts and de-duplicates filter values, repositories case-insensitively", () => {
    const parsed = parse("repo=Acme/B&repo=acme/b&repo=acme/a&tag=z&tag=a&tag=z");
    // the first spelling wins; order is by code unit
    expect(parsed.repos).toEqual(["Acme/B", "acme/a"]);
    expect(parsed.tags).toEqual(["a", "z"]);
  });

  it("drops filter values that can match nothing instead of keeping a dead filter", () => {
    const parsed = parse(
      `type=&tag=${"x".repeat(300)}&status=a%00b&repo=noslash&repo=/x&repo=x/&repo=a/b/c&repo=42`,
    );
    expect(parsed.types).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.statuses).toEqual([]);
    expect(parsed.repos).toEqual([]);
  });

  it("clamps page and limit and ignores junk", () => {
    expect(parse("page=0").page).toBe(1);
    expect(parse("page=-3").page).toBe(1);
    expect(parse("page=abc").page).toBe(1);
    expect(parse("page=1.5").page).toBe(1);
    expect(parse("page=99999999999").page).toBe(1);
    expect(parse("page=999999").page).toBe(MAX_PAGE);
    expect(parse("limit=0").limit).toBe(20);
    expect(parse("limit=500").limit).toBe(100);
    expect(parse("limit=100").limit).toBe(100);
    expect(parse("limit=1").limit).toBe(1);
    expect(parse("limit=-5").limit).toBe(20);
    expect(parse("limit=1e2").limit).toBe(20);
  });

  it("cleans control characters and cuts an over-long query", () => {
    expect(parse("q=%00a%07b%0A%09c").q).toBe("a b c");
    expect(parse(`q=${"x".repeat(5000)}`).q).toHaveLength(MAX_QUERY_CHARS);
    expect(parseSearchParams({ q: "a\uD800b" }).q).toBe("a b");
  });

  it("caps the number of values per kind", () => {
    const many = Array.from({ length: 80 }, (_, i) => `tag=t${String(i).padStart(2, "0")}`).join(
      "&",
    );
    expect(parse(many).tags).toHaveLength(MAX_FILTER_VALUES);
  });

  it("is not fooled by prototype keys or non-string values", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"q":"polluted"},"constructor":"x","q":["a",{"x":1},7],"repo":[null,"a/b"]}',
    ) as Record<string, string | string[]>;
    const parsed = parseSearchParams(hostile);
    expect(parsed.q).toBe("a");
    expect(parsed.repos).toEqual(["a/b"]);
    expect(({} as Record<string, unknown>).q).toBeUndefined();
    expect(parseSearchParams(Object.create({ q: "inherited" }) as Record<string, string>).q).toBe(
      "",
    );
  });

  it("never throws on hostile text", () => {
    for (const q of [
      '"unclosed & | ! ( ',
      "<script>alert(1)</script>",
      "%",
      "%%",
      "\\",
      "'; drop table documents;--",
      "\u0000",
      "a".repeat(100_000),
    ]) {
      expect(() =>
        parseSearchParams({ q, repo: q, type: q, tag: q, status: q, page: q, limit: q }),
      ).not.toThrow();
    }
  });
});

describe("buildSearchUrl", () => {
  it("is /search for the empty state", () => {
    expect(buildSearchUrl()).toBe("/search");
    expect(buildSearchUrl(EMPTY_SEARCH_STATE)).toBe("/search");
  });

  it("writes sorted keys, omits defaults and encodes values", () => {
    const url = buildSearchUrl(
      state({
        q: "rate limit",
        repos: ["acme/api-service"],
        types: ["Metric"],
        tags: ["b", "a"],
        statuses: ["draft"],
        page: 2,
        limit: 10,
      }),
    );
    expect(url).toBe(
      "/search?limit=10&page=2&q=rate%20limit&repo=acme%2Fapi-service&status=draft&tag=a&tag=b&type=Metric",
    );
  });

  it("matches the documented example", () => {
    expect(buildSearchUrl(state({ q: "deployment", repos: ["acme/api-service"] }))).toBe(
      "/search?q=deployment&repo=acme%2Fapi-service",
    );
  });

  it("writes the same URL for the same state, whatever the order of values", () => {
    const a = buildSearchUrl(state({ q: "x", tags: ["b", "a", "b"], repos: ["z/z", "a/a"] }));
    const b = buildSearchUrl(state({ q: "x", tags: ["a", "b"], repos: ["a/a", "z/z"] }));
    expect(a).toBe(b);
  });

  it("encodes characters that are awkward in URLs, including ones encodeURIComponent keeps", () => {
    const url = buildSearchUrl(state({ q: `it's (a) "test" *!&=#?+%/\\<>` }));
    expect(url).not.toMatch(/['()*!"<> ]/);
    expect(url.split("?")[1]).toMatch(/^q=[A-Za-z0-9%._~-]+$/);
    expect(parse(url.split("?")[1] ?? "").q).toBe(`it's (a) "test" *!&=#?+%/\\<>`);
  });

  it("omits page 1, the default size and an empty query", () => {
    expect(buildSearchUrl(state({ page: 1, limit: 20, q: "  " }))).toBe("/search");
    expect(buildSearchUrl(state({ page: 0 }))).toBe("/search");
    expect(buildSearchUrl(state({ limit: 5000 }))).toBe("/search?limit=100");
  });

  it("re-normalizes: control characters and long queries never reach a URL", () => {
    expect(buildSearchUrl({ q: "a\u0000b\u0007c" })).toBe("/search?q=a%20b%20c");
    expect(buildSearchUrl({ q: "x".repeat(1000) })).toBe(
      `/search?q=${"x".repeat(MAX_QUERY_CHARS)}`,
    );
  });
});

describe("round trip", () => {
  const samples: SearchState[] = [
    EMPTY_SEARCH_STATE,
    state({ q: "deployment" }),
    state({ q: "a & b | !c (d", repos: ["acme/api-service", "globex/handbook"] }),
    state({ q: "ünïcödé 日本語 😀", types: ["Metric", "metric", "a b"], tags: ["x/y", "100%"] }),
    state({ statuses: ["draft", "deprecated"], page: 7, limit: 100 }),
    state({ q: `"quoted" -excluded or other`, repos: ["Acme/Mixed-Case"], page: 2 }),
    state({ q: "<script>alert(1)</script>", tags: ["<b>", "'; --"] }),
  ];

  for (const sample of samples) {
    it(`parse(build(s)) equals s for ${JSON.stringify(sample).slice(0, 60)}`, () => {
      const url = buildSearchUrl(sample);
      const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const parsed = parse(query);
      // Parsed states are canonical (sorted); the sample may not be.
      expect(buildSearchUrl(parsed)).toBe(url);
      expect(parse(buildSearchUrl(parsed).split("?")[1] ?? "")).toEqual(parsed);
    });
  }

  it("build(parse(url)) is stable for hostile URLs", () => {
    const hostile =
      "q=%22%00&repo=A/B&repo=a/b&type=%FF&tag=%E0%A4%A&page=0x10&limit=--1&unknown=1";
    const once = buildSearchUrl(parse(hostile));
    const twice = buildSearchUrl(parse(once.split("?")[1] ?? ""));
    expect(twice).toBe(once);
  });
});

describe("state helpers", () => {
  const base = state({ q: "x", repos: ["acme/api"], types: ["Metric"], page: 4 });

  it("toggles a value on and off and goes back to page 1", () => {
    const added = toggleFilter(base, "tag", "finance");
    expect(added.tags).toEqual(["finance"]);
    expect(added.page).toBe(1);
    expect(toggleFilter(added, "tag", "finance").tags).toEqual([]);
  });

  it("compares repositories case-insensitively, other values exactly", () => {
    expect(isFilterSelected(base, "repo", "ACME/API")).toBe(true);
    expect(toggleFilter(base, "repo", "Acme/Api").repos).toEqual([]);
    expect(isFilterSelected(base, "type", "metric")).toBe(false);
    expect(toggleFilter(base, "type", "metric").types).toEqual(["Metric", "metric"]);
  });

  it("does not exceed the filter value cap", () => {
    let current = EMPTY_SEARCH_STATE;
    for (let i = 0; i < MAX_FILTER_VALUES + 5; i++) current = toggleFilter(current, "tag", `t${i}`);
    expect(current.tags).toHaveLength(MAX_FILTER_VALUES);
  });

  it("counts and clears filters but keeps the query and size", () => {
    expect(filterCount(base)).toBe(2);
    expect(hasFilters(base)).toBe(true);
    const cleared = clearFilters({ ...base, limit: 10 });
    expect(hasFilters(cleared)).toBe(false);
    expect(cleared).toMatchObject({ q: "x", limit: 10, page: 1 });
  });

  it("keeps filters and size for a new query but resets the page", () => {
    const next = withQuery({ ...base, limit: 10 }, "  new   query ");
    expect(next).toMatchObject({ q: "new query", repos: ["acme/api"], limit: 10, page: 1 });
  });

  it("describes the hidden form fields of a search", () => {
    expect(formFields(EMPTY_SEARCH_STATE)).toEqual([]);
    expect(formFields({ ...base, tags: ["a"], limit: 10 })).toEqual([
      { name: "repo", value: "acme/api" },
      { name: "type", value: "Metric" },
      { name: "tag", value: "a" },
      { name: "limit", value: "10" },
    ]);
  });

  it("computes the offset of a page", () => {
    expect(offsetFor(state({ page: 1 }))).toBe(0);
    expect(offsetFor(state({ page: 3, limit: 20 }))).toBe(40);
  });

  it("builds just the filter part of a URL for other pages to reuse", () => {
    expect(buildFilterQuery(state({ types: ["Metric"], tags: ["b", "a"] }))).toBe(
      "tag=a&tag=b&type=Metric",
    );
    expect(buildFilterQuery(EMPTY_SEARCH_STATE)).toBe("");
  });

  it("sets a page without touching the rest", () => {
    expect(withPage(base, 9)).toEqual({ ...base, page: 9 });
  });
});

describe("computePaging", () => {
  it("describes a middle page", () => {
    const paging = computePaging(state({ page: 2 }), 87, 20);
    expect(paging).toMatchObject({
      from: 21,
      to: 40,
      total: 87,
      lastPage: 5,
      prevPage: 1,
      nextPage: 3,
      capped: false,
      outOfRange: false,
    });
  });

  it("has no previous link on the first page and no next link on the last", () => {
    expect(computePaging(state({ page: 1 }), 87, 20)).toMatchObject({
      prevPage: null,
      nextPage: 2,
    });
    expect(computePaging(state({ page: 5 }), 87, 7)).toMatchObject({
      from: 81,
      to: 87,
      prevPage: 4,
      nextPage: null,
    });
  });

  it("is a single page without links for few results, and for none", () => {
    expect(computePaging(state({}), 3, 3)).toMatchObject({
      from: 1,
      to: 3,
      prevPage: null,
      nextPage: null,
    });
    expect(computePaging(state({}), 0, 0)).toMatchObject({
      from: 0,
      to: 0,
      lastPage: 1,
      outOfRange: false,
    });
  });

  it("flags a page past the end and points back to the last one", () => {
    const paging = computePaging(state({ page: 9 }), 45, 0);
    expect(paging).toMatchObject({ outOfRange: true, lastPage: 3, prevPage: 3, nextPage: null });
  });

  it("caps browsing at the deepest offset the query layer serves", () => {
    const paging = computePaging(state({ page: 51 }), 5000, 20);
    expect(paging).toMatchObject({ lastPage: 51, capped: true, nextPage: null, prevPage: 50 });
    expect(computePaging(state({ page: 50 }), 5000, 20).nextPage).toBe(51);
    // the last page that can be shown has offset <= 1000
    expect(offsetFor(state({ page: 51 }))).toBe(1000);
    expect(computePaging(state({ limit: 100, page: 11 }), 5000, 100)).toMatchObject({
      lastPage: 11,
      capped: true,
    });
  });
});
