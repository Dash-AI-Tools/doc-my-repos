// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  computePaging,
  EMPTY_SEARCH_STATE,
  type SearchState,
} from "@docmyrepos/core/internal/search-params";

import {
  NoQueryState,
  NoResultsState,
  ResultSummary,
  SearchErrorState,
  SearchPagination,
} from "./search-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const state = (over: Partial<SearchState> = {}): SearchState => ({
  ...EMPTY_SEARCH_STATE,
  q: "deployment",
  ...over,
});

describe("ResultSummary", () => {
  it("is a polite live region with the range and the total", () => {
    const s = state({ page: 2 });
    render(<ResultSummary query="deployment" paging={computePaging(s, 87, 20)} />);
    const summary = screen.getByRole("status");
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect(summary.textContent).toBe("Showing 21–40 of 87 results for “deployment”");
  });

  it("uses the singular for one result and omits the range", () => {
    render(<ResultSummary query="x" paging={computePaging(state(), 1, 1)} />);
    expect(screen.getByRole("status").textContent).toBe("Showing 1 of 1 result for \u201cx\u201d");
  });

  it("says there are no results", () => {
    render(<ResultSummary query="zzz" paging={computePaging(state(), 0, 0)} />);
    expect(screen.getByRole("status").textContent).toBe("No results for \u201czzz\u201d");
  });

  it("explains a page past the end", () => {
    render(<ResultSummary query="x" paging={computePaging(state({ page: 9 }), 45, 0)} />);
    expect(screen.getByRole("status").textContent).toContain(
      "45 results for \u201cx\u201d, but not on this page",
    );
  });
});

describe("SearchPagination", () => {
  it("links to the previous and next page with canonical URLs", () => {
    const s = state({ page: 2, repos: ["acme/api"] });
    render(<SearchPagination state={s} paging={computePaging(s, 87, 20)} />);
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(within(nav).getByTestId("page-prev").getAttribute("href")).toBe(
      "/search?q=deployment&repo=acme%2Fapi",
    );
    expect(within(nav).getByTestId("page-next").getAttribute("href")).toBe(
      "/search?page=3&q=deployment&repo=acme%2Fapi",
    );
    expect(within(nav).getByTestId("page-position").textContent).toBe("Page 2 of 5");
  });

  it("has only Next on the first page", () => {
    const s = state();
    render(<SearchPagination state={s} paging={computePaging(s, 45, 20)} />);
    expect(screen.queryByTestId("page-prev")).toBeNull();
    expect(screen.getByTestId("page-next").getAttribute("href")).toBe(
      "/search?page=2&q=deployment",
    );
  });

  it("has only Previous on the last page", () => {
    const s = state({ page: 3 });
    render(<SearchPagination state={s} paging={computePaging(s, 45, 5)} />);
    expect(screen.queryByTestId("page-next")).toBeNull();
    expect(screen.getByTestId("page-prev").getAttribute("href")).toBe(
      "/search?page=2&q=deployment",
    );
  });

  it("renders nothing for a single page", () => {
    const s = state();
    const { container } = render(<SearchPagination state={s} paging={computePaging(s, 5, 5)} />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps a custom page size in the links", () => {
    const s = state({ limit: 10 });
    render(<SearchPagination state={s} paging={computePaging(s, 25, 10)} />);
    expect(screen.getByTestId("page-next").getAttribute("href")).toBe(
      "/search?limit=10&page=2&q=deployment",
    );
  });

  it("explains the deepest-page cap on the last browsable page", () => {
    const s = state({ page: 51 });
    render(<SearchPagination state={s} paging={computePaging(s, 5000, 20)} />);
    expect(screen.queryByTestId("page-next")).toBeNull();
    expect(screen.getByTestId("results-capped").textContent).toContain("first 1020 results");
  });

  it("offers a way back from a page past the end", () => {
    const s = state({ page: 9 });
    render(<SearchPagination state={s} paging={computePaging(s, 45, 0)} />);
    expect(screen.getByTestId("page-out-of-range").textContent).toContain("Page 9 is past");
    const back = screen.getByTestId("page-prev");
    expect(back.textContent).toBe("Go to the last page (3)");
    expect(back.getAttribute("href")).toBe("/search?page=3&q=deployment");
    expect(screen.queryByTestId("page-next")).toBeNull();
  });
});

describe("NoResultsState", () => {
  it("echoes the query back as text", () => {
    render(<NoResultsState query="rate limitz" state={state({ q: "rate limitz" })} />);
    expect(screen.getByTestId("no-results")).toBeTruthy();
    expect(screen.getByTestId("echoed-query").textContent).toBe("rate limitz");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "Nothing found for \u201crate limitz\u201d",
    );
  });

  it("escapes markup in the query", () => {
    const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    const { container } = render(<NoResultsState query={hostile} state={state({ q: hostile })} />);
    expect(container.querySelector("script, img")).toBeNull();
    expect(screen.getByTestId("echoed-query").textContent).toBe(hostile);
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });

  it("suggests removing filters only when some are selected", () => {
    render(<NoResultsState query="x" state={state()} />);
    expect(screen.queryByTestId("remove-filters")).toBeNull();
    expect(screen.getByText("Check the spelling.")).toBeTruthy();
    cleanup();
    render(
      <NoResultsState query="x" state={state({ q: "x", repos: ["a/b"], tags: ["t"], page: 2 })} />,
    );
    expect(screen.getByTestId("remove-filters").getAttribute("href")).toBe("/search?q=x");
  });
});

describe("NoQueryState", () => {
  it("explains how to search and links home", () => {
    render(<NoQueryState />);
    expect(screen.getByTestId("no-query").textContent).toContain("Type a word or phrase");
    expect(screen.getByRole("link", { name: "browse the repositories" }).getAttribute("href")).toBe(
      "/",
    );
  });
});

describe("SearchErrorState", () => {
  it("is a fixed alert with a retry link to the same search", () => {
    render(<SearchErrorState state={state({ repos: ["a/b"] })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Search is unavailable");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/search?q=deployment&repo=a%2Fb",
    );
  });
});
