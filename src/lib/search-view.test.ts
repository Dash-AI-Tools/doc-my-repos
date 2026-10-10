import { describe, expect, it } from "vitest";

import { EMPTY_SEARCH_STATE, type SearchState } from "./search-params";
import {
  buildActiveFilters,
  buildFacetGroups,
  clearFiltersHref,
  FACET_VISIBLE,
  splitFacetOptions,
  type FacetCounts,
  type FacetOption,
} from "./search-view";

const state = (partial: Partial<SearchState>): SearchState => ({
  ...EMPTY_SEARCH_STATE,
  q: "deploy",
  ...partial,
});

const NO_FACETS: FacetCounts = { repos: [], types: [], tags: [], statuses: [] };

const FACETS: FacetCounts = {
  repos: [
    { owner: "acme", name: "api", count: 5 },
    { owner: "acme", name: "kb", count: 2 },
  ],
  types: [
    { value: "concept", count: 2 },
    { value: "Concept", count: 1 },
  ],
  tags: [{ value: "infra", count: 3 }],
  statuses: [{ value: "draft", count: 1 }],
};

describe("buildFacetGroups", () => {
  it("lists Repository, Type, Tag, Status in that order with counts", () => {
    const groups = buildFacetGroups(state({}), FACETS);
    expect(groups.map((g) => g.label)).toEqual(["Repository", "Type", "Tag", "Status"]);
    expect(groups[0]?.options.map((o) => [o.label, o.count])).toEqual([
      ["acme/api", 5],
      ["acme/kb", 2],
    ]);
  });

  it("keeps case variants of a type as separate values", () => {
    const types = buildFacetGroups(state({}), FACETS).find((g) => g.kind === "type");
    expect(types?.options.map((o) => o.value)).toEqual(["concept", "Concept"]);
  });

  it("hides the OKF groups when no result has such values", () => {
    const groups = buildFacetGroups(state({}), {
      ...NO_FACETS,
      repos: [{ owner: "acme", name: "api", count: 4 }],
    });
    expect(groups.map((g) => g.kind)).toEqual(["repo"]);
  });

  it("shows no group at all when nothing matched and nothing is selected", () => {
    expect(buildFacetGroups(state({}), NO_FACETS)).toEqual([]);
  });

  it("links every option to the URL with that value added", () => {
    const groups = buildFacetGroups(state({ q: "deployment" }), FACETS);
    expect(groups[0]?.options[0]?.href).toBe("/search?q=deployment&repo=acme%2Fapi");
    expect(groups[1]?.options[1]?.href).toBe("/search?q=deployment&type=Concept");
  });

  it("links a selected option to the URL without it, and marks it selected", () => {
    const groups = buildFacetGroups(
      state({ q: "deployment", repos: ["acme/api"], page: 3 }),
      FACETS,
    );
    const api = groups[0]?.options[0];
    expect(api).toMatchObject({ value: "acme/api", selected: true, href: "/search?q=deployment" });
    // adding a second value keeps the first and goes back to page 1
    expect(groups[0]?.options[1]?.href).toBe("/search?q=deployment&repo=acme%2Fapi&repo=acme%2Fkb");
  });

  it("matches a selected repository case-insensitively", () => {
    const groups = buildFacetGroups(state({ repos: ["ACME/API"] }), FACETS);
    expect(groups[0]?.options.filter((o) => o.selected).map((o) => o.value)).toEqual(["acme/api"]);
  });

  it("puts selected options first", () => {
    const groups = buildFacetGroups(state({ repos: ["acme/kb"] }), FACETS);
    expect(groups[0]?.options.map((o) => o.value)).toEqual(["acme/kb", "acme/api"]);
  });

  it("keeps a selected value that has no count, so it can be removed", () => {
    const groups = buildFacetGroups(state({ types: ["Gone"] }), {
      ...FACETS,
      types: [],
    });
    const types = groups.find((g) => g.kind === "type");
    expect(types?.options).toEqual([
      { value: "Gone", label: "Gone", count: 0, selected: true, href: "/search?q=deploy" },
    ]);
  });

  it("combines filters of different kinds in one URL", () => {
    const groups = buildFacetGroups(state({ types: ["concept"] }), FACETS);
    const tag = groups.find((g) => g.kind === "tag")?.options[0];
    expect(tag?.href).toBe("/search?q=deploy&tag=infra&type=concept");
  });
});

describe("buildActiveFilters", () => {
  it("lists each selected value with the URL that removes only it", () => {
    const active = buildActiveFilters(state({ repos: ["acme/api"], tags: ["a", "b"] }));
    expect(active.map((f) => [f.kindLabel, f.value, f.removeHref])).toEqual([
      ["Repository", "acme/api", "/search?q=deploy&tag=a&tag=b"],
      ["Tag", "a", "/search?q=deploy&repo=acme%2Fapi&tag=b"],
      ["Tag", "b", "/search?q=deploy&repo=acme%2Fapi&tag=a"],
    ]);
  });

  it("is empty without filters, and clearing keeps the query", () => {
    expect(buildActiveFilters(state({}))).toEqual([]);
    expect(clearFiltersHref(state({ q: "x y", repos: ["a/b"], page: 2 }))).toBe("/search?q=x%20y");
  });
});

describe("splitFacetOptions", () => {
  const option = (value: string, selected = false): FacetOption => ({
    value,
    label: value,
    count: 1,
    selected,
    href: "/search",
  });

  it("shows everything up to the limit", () => {
    const options = ["a", "b", "c"].map((v) => option(v));
    expect(splitFacetOptions(options)).toEqual({ shown: options, more: [] });
  });

  it("puts the rest behind show more", () => {
    const options = Array.from({ length: FACET_VISIBLE + 3 }, (_, i) => option(`v${i}`));
    const { shown, more } = splitFacetOptions(options);
    expect(shown).toHaveLength(FACET_VISIBLE);
    expect(more.map((o) => o.value)).toEqual(["v6", "v7", "v8"]);
  });

  it("always shows selected options, even past the limit", () => {
    const options = [
      ...Array.from({ length: 8 }, (_, i) => option(`s${i}`, true)),
      ...Array.from({ length: 4 }, (_, i) => option(`o${i}`)),
    ];
    const { shown, more } = splitFacetOptions(options);
    expect(shown.filter((o) => o.selected)).toHaveLength(8);
    expect(more).toHaveLength(4);
  });
});
