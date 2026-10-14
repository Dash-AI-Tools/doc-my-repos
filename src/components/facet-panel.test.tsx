// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_SEARCH_STATE, type SearchState } from "@/lib/search-params";
import {
  buildActiveFilters,
  buildFacetGroups,
  clearFiltersHref,
  type FacetCounts,
} from "@/lib/search-view";

import { FacetPanel } from "./facet-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const FACETS: FacetCounts = {
  repos: [
    { owner: "acme", name: "api", count: 5 },
    { owner: "acme", name: "kb", count: 1 },
  ],
  types: [{ value: "concept", count: 2 }],
  tags: [{ value: "infra", count: 3 }],
  statuses: [{ value: "draft", count: 1 }],
};

function panel(over: Partial<SearchState> = {}, facets: FacetCounts = FACETS) {
  const state: SearchState = { ...EMPTY_SEARCH_STATE, q: "deployment", ...over };
  return render(
    <FacetPanel
      groups={buildFacetGroups(state, facets)}
      active={buildActiveFilters(state)}
      clearHref={clearFiltersHref(state)}
    />,
  );
}

describe("FacetPanel", () => {
  it("renders every option as a real link to the toggled URL, with its count", () => {
    panel();
    const repo = screen.getByTestId("facet-group-repo");
    const api = within(repo).getByRole("link", { name: /acme\/api/ });
    expect(api.getAttribute("href")).toBe("/search?q=deployment&repo=acme%2Fapi");
    expect(within(api).getByTestId("facet-count").textContent).toBe("5 results");
    expect(within(repo).getByRole("link", { name: /acme\/kb/ }).textContent).toContain("1 result");
  });

  it("marks a selected option, links it to the URL without it and says so to screen readers", () => {
    panel({ repos: ["acme/api"] });
    const api = within(screen.getByTestId("facet-group-repo")).getByRole("link", {
      name: /acme\/api/,
    });
    expect(api.getAttribute("aria-current")).toBe("true");
    expect(api.getAttribute("data-selected")).toBe("true");
    expect(api.getAttribute("href")).toBe("/search?q=deployment");
    expect(api.textContent).toContain("selected, press to remove this filter");
    const kb = within(screen.getByTestId("facet-group-repo")).getByRole("link", {
      name: /acme\/kb/,
    });
    expect(kb.getAttribute("aria-current")).toBeNull();
    expect(kb.getAttribute("href")).toBe("/search?q=deployment&repo=acme%2Fapi&repo=acme%2Fkb");
  });

  it("shows the selected option first", () => {
    panel({ repos: ["acme/kb"] });
    const links = within(screen.getByTestId("facet-group-repo")).getAllByTestId("facet-option");
    expect(links[0]?.textContent).toContain("acme/kb");
  });

  it("shows the Type, Tag and Status groups when there are values", () => {
    panel();
    for (const kind of ["repo", "type", "tag", "status"]) {
      expect(screen.getByTestId(`facet-group-${kind}`)).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Status" })).toBeTruthy();
  });

  it("hides the OKF groups when the results have no such values", () => {
    panel({}, { ...FACETS, types: [], tags: [], statuses: [] });
    expect(screen.getByTestId("facet-group-repo")).toBeTruthy();
    expect(screen.queryByTestId("facet-group-type")).toBeNull();
    expect(screen.queryByTestId("facet-group-tag")).toBeNull();
    expect(screen.queryByTestId("facet-group-status")).toBeNull();
    expect(screen.queryByText("Type")).toBeNull();
  });

  it("lists selected filters with a Remove filter link each and a Clear all link", () => {
    panel({ repos: ["acme/api"], types: ["concept"] });
    const active = screen.getByTestId("active-filters");
    const remove = within(active).getAllByTestId("active-filter");
    expect(remove).toHaveLength(2);
    expect(remove[0]?.textContent).toContain("Remove filter Repository: acme/api");
    expect(remove[0]?.getAttribute("href")).toBe("/search?q=deployment&type=concept");
    expect(remove[1]?.getAttribute("href")).toBe("/search?q=deployment&repo=acme%2Fapi");
    const clear = within(active).getByRole("link", { name: "Clear all filters" });
    expect(clear.getAttribute("href")).toBe("/search?q=deployment");
    expect(screen.getByTestId("filter-count").textContent).toBe("(2 selected)");
  });

  it("has no selected-filters section without filters", () => {
    panel();
    expect(screen.queryByTestId("active-filters")).toBeNull();
    expect(screen.queryByTestId("filter-count")).toBeNull();
  });

  it("collapses a long list behind a native Show more disclosure", () => {
    const repos = Array.from({ length: 10 }, (_, i) => ({
      owner: "acme",
      name: `r${i}`,
      count: 10 - i,
    }));
    panel({}, { ...FACETS, repos });
    const group = screen.getByTestId("facet-group-repo");
    const more = within(group).getByTestId("facet-more-repo");
    expect(more.tagName).toBe("DETAILS");
    expect(within(more).getAllByTestId("facet-option")).toHaveLength(4);
    expect(within(more).getByText("Show 4 more")).toBeTruthy();
    // the first six are outside the disclosure
    expect(within(group).getAllByTestId("facet-option")).toHaveLength(10);
  });

  it("keeps a selected value out of the collapsed part", () => {
    const repos = Array.from({ length: 10 }, (_, i) => ({
      owner: "acme",
      name: `r${i}`,
      count: 10 - i,
    }));
    panel({ repos: ["acme/r9"] }, { ...FACETS, repos });
    const more = screen.getByTestId("facet-more-repo");
    expect(more.textContent).not.toContain("acme/r9");
  });

  it("renders nothing when there is nothing to filter or remove", () => {
    const { container } = panel({}, { repos: [], types: [], tags: [], statuses: [] });
    expect(container.innerHTML).toBe("");
  });

  it("renders hostile facet values as text", () => {
    panel({}, { ...FACETS, tags: [{ value: "<img src=x onerror=alert(1)>", count: 1 }] });
    const group = screen.getByTestId("facet-group-tag");
    expect(group.querySelector("img")).toBeNull();
    expect(group.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(within(group).getByRole("link").getAttribute("href")).toBe(
      "/search?q=deployment&tag=%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E",
    );
  });
});
