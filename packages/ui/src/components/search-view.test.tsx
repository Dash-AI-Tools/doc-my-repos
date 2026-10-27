// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HIGHLIGHT_END as E, HIGHLIGHT_START as S } from "@docmyrepos/core/internal/search";
import {
  computePaging,
  EMPTY_SEARCH_STATE,
  type SearchState,
} from "@docmyrepos/core/internal/search-params";
import {
  buildActiveFilters,
  buildFacetGroups,
  type ResultItemData,
  type SearchPageView,
} from "@docmyrepos/core/internal/search-view";

import { SearchView } from "./search-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const item = (n: number): ResultItemData => ({
  key: String(n),
  title: `Doc ${n}`,
  href: `/acme/api/docs/d${n}`,
  repoLabel: "acme/api",
  repoHref: "/acme/api",
  path: `docs/d${n}.md`,
  section: null,
  snippet: `about ${S}deployment${E}`,
  isPrivate: false,
  type: null,
  status: null,
  tags: [],
});

function okView(
  over: Partial<SearchState> = {},
  hits = [item(1), item(2)],
  total = hits.length,
): SearchPageView {
  const state: SearchState = { ...EMPTY_SEARCH_STATE, q: "deployment", ...over };
  return {
    status: "ok",
    state,
    query: state.q,
    total,
    hits,
    groups: buildFacetGroups(state, {
      repos: hits.length > 0 ? [{ owner: "acme", name: "api", count: total }] : [],
      types: [],
      tags: [],
      statuses: [],
    }),
    active: buildActiveFilters(state),
    paging: computePaging(state, total, hits.length),
  };
}

describe("SearchView", () => {
  it("renders the heading, the search form with the query, the facets and the results", () => {
    render(<SearchView view={okView()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeTruthy();
    const form = screen.getByRole("search", { name: "Search documentation" });
    expect(within(form).getByRole("searchbox").getAttribute("value")).toBe("deployment");
    expect(screen.getByTestId("facet-panel")).toBeTruthy();
    expect(screen.getAllByTestId("result")).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe(
      "Showing 1–2 of 2 results for “deployment”",
    );
  });

  it("keeps the filters and the page size in the form, but not the page", () => {
    render(
      <SearchView
        view={okView(
          { repos: ["acme/api"], types: ["concept"], limit: 10, page: 2 },
          [item(1)],
          11,
        )}
      />,
    );
    const form = screen.getByRole("search");
    const hidden = [...form.querySelectorAll("input[type=hidden]")].map(
      (input) => `${input.getAttribute("name")}=${input.getAttribute("value")}`,
    );
    expect(hidden).toEqual(["repo=acme/api", "type=concept", "limit=10"]);
  });

  it("shows instructions, and no facets, before a query", () => {
    render(<SearchView view={{ status: "idle", state: EMPTY_SEARCH_STATE }} />);
    expect(screen.getByTestId("no-query")).toBeTruthy();
    expect(screen.queryByTestId("facet-panel")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the empty state with the query echoed back when nothing matched", () => {
    render(<SearchView view={okView({ q: "<script>x</script>" }, [], 0)} />);
    expect(screen.getByTestId("no-results")).toBeTruthy();
    expect(within(screen.getByTestId("no-results")).getByTestId("echoed-query").textContent).toBe(
      "<script>x</script>",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByTestId("results")).toBeNull();
  });

  it("keeps the selected filters removable even when nothing matched", () => {
    render(<SearchView view={okView({ repos: ["acme/api"] }, [], 0)} />);
    expect(screen.getByTestId("active-filters")).toBeTruthy();
    expect(screen.getByTestId("remove-filters")).toBeTruthy();
  });

  it("shows no empty state for a page past the end", () => {
    render(<SearchView view={okView({ page: 9 }, [], 45)} />);
    expect(screen.queryByTestId("no-results")).toBeNull();
    expect(screen.getByTestId("page-out-of-range")).toBeTruthy();
  });

  it("shows the error state with the form still usable", () => {
    render(<SearchView view={{ status: "error", state: { ...EMPTY_SEARCH_STATE, q: "x" } }} />);
    expect(screen.getByTestId("search-error")).toBeTruthy();
    expect(screen.getByRole("search")).toBeTruthy();
    expect(screen.queryByTestId("results")).toBeNull();
  });

  it("uses one column when there is nothing to filter", () => {
    const { container } = render(<SearchView view={okView({}, [], 0)} />);
    expect(container.querySelector(".lg\\:grid-cols-\\[16rem_minmax\\(0\\,1fr\\)\\]")).toBeNull();
  });
});

describe("SearchView: Ask instead", () => {
  const link = () => screen.queryByTestId("ask-instead");

  it("offers the Ask page with the query, only when Ask is on and there is a query", () => {
    render(<SearchView view={okView()} askHref="/ask?q=deployment" />);
    expect(link()?.getAttribute("href")).toBe("/ask?q=deployment");
    expect(link()?.textContent).toBe("Ask instead");
  });

  it("shows it on a search with no results too", () => {
    render(<SearchView view={okView({}, [], 0)} askHref="/ask?q=deployment" />);
    expect(link()).not.toBeNull();
  });

  it("shows nothing when Ask is off", () => {
    render(<SearchView view={okView()} />);
    expect(link()).toBeNull();
    cleanup();
    render(<SearchView view={okView()} askHref={null} />);
    expect(link()).toBeNull();
  });

  it("shows nothing before a query is entered", () => {
    render(<SearchView view={{ status: "idle", state: EMPTY_SEARCH_STATE }} askHref="/ask?q=" />);
    expect(link()).toBeNull();
  });
});
