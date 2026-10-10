import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SEARCH_STATE, type SearchState } from "@/lib/search-params";
import type { SearchPageView } from "@/lib/search-view";

const loadSearchPage = vi.fn<(state: SearchState) => Promise<SearchPageView>>();
vi.mock("@/server/search-page", () => ({
  loadSearchPage: (state: SearchState) => loadSearchPage(state),
}));

import SearchPage, { dynamic, generateMetadata } from "./page";

async function html(params: Record<string, string | string[] | undefined>): Promise<string> {
  return renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  loadSearchPage.mockReset();
  loadSearchPage.mockImplementation((state) => Promise.resolve({ status: "idle", state }));
});

describe("search page", () => {
  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("parses the URL into the state the loader gets", async () => {
    await html({
      q: "deploy",
      repo: ["acme/api", "acme/web"],
      type: "Metric",
      page: "2",
      limit: "10",
    });
    expect(loadSearchPage).toHaveBeenCalledWith({
      ...EMPTY_SEARCH_STATE,
      q: "deploy",
      repos: ["acme/api", "acme/web"],
      types: ["Metric"],
      page: 2,
      limit: 10,
    });
  });

  it("renders the instructions without a query", async () => {
    const out = await html({});
    expect(out).toMatch(/<h1[^>]*>Search<\/h1>/);
    expect(out).toContain('data-testid="no-query"');
    expect(out).toContain('action="/search"');
  });

  it("renders the error state in the page", async () => {
    loadSearchPage.mockImplementation((state) => Promise.resolve({ status: "error", state }));
    const out = await html({ q: "x" });
    expect(out).toContain("Search is unavailable");
    expect(out).toMatch(/<h1[^>]*>Search<\/h1>/);
  });

  it("lets an unexpected error reach the error boundary", async () => {
    loadSearchPage.mockImplementation(() => Promise.reject(new TypeError("bug")));
    await expect(html({ q: "x" })).rejects.toThrow("bug");
  });
});

describe("search page metadata", () => {
  const meta = (params: Record<string, string | string[] | undefined>) =>
    generateMetadata({ searchParams: Promise.resolve(params) });

  it("titles the page Search without a query", async () => {
    expect((await meta({})).title).toBe("Search · DocMyRepos");
  });

  it("puts the query in the title", async () => {
    expect((await meta({ q: "rate limit" })).title).toBe('"rate limit" · Search');
  });

  it("cuts a long query in the title", async () => {
    const title = String((await meta({ q: "x".repeat(200) })).title);
    expect(title).toBe(`"${"x".repeat(60)}…" · Search`);
  });

  it("is not indexed", async () => {
    expect((await meta({ q: "x" })).robots).toEqual({ index: false, follow: true });
    expect((await meta({})).robots).toEqual({ index: false, follow: true });
  });
});
