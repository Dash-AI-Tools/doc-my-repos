import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  computePaging,
  EMPTY_SEARCH_STATE,
  type SearchState,
} from "@docmyrepos/core/internal/search-params";
import { buildFacetGroups, type SearchPageView } from "@docmyrepos/core/internal/search-view";

const loadSearchPage = vi.fn<(state: SearchState) => Promise<SearchPageView>>();
vi.mock("@docmyrepos/server/internal/search-page", () => ({
  loadSearchPage: (state: SearchState) => loadSearchPage(state),
}));

const askState = vi.hoisted(() => ({ current: { state: "off" } as { state: string } }));
vi.mock("@docmyrepos/server/internal/ask/settings", () => ({
  askStateFor: async () => askState.current,
}));

import { SearchPage, generateMetadata } from "./search";
import { testApp } from "./test-app";

const TEST_APP = testApp();

async function html(params: Record<string, string | string[] | undefined>): Promise<string> {
  return renderToStaticMarkup(
    await SearchPage({ app: TEST_APP, searchParams: Promise.resolve(params) }),
  );
}

beforeEach(() => {
  askState.current = { state: "off" };
  loadSearchPage.mockReset();
  loadSearchPage.mockImplementation((state) => Promise.resolve({ status: "idle", state }));
});

describe("search page", () => {
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

  it("offers Ask instead, with the query encoded, only when Ask is ready", async () => {
    loadSearchPage.mockImplementation((state) => Promise.resolve({ status: "error", state }));
    expect(await html({ q: "rotate keys & more" })).not.toContain("Ask instead");
    askState.current = { state: "unavailable" };
    expect(await html({ q: "rotate keys" })).not.toContain("Ask instead");
    askState.current = { state: "ready" };
    const out = await html({ q: "rotate keys & more" });
    expect(out).toContain('href="/ask?q=rotate%20keys%20%26%20more"');
    expect(out).toContain("Ask instead");
    expect(await html({})).not.toContain("Ask instead"); // no query, no link
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
    expect((await meta({})).title).toBe("Search");
  });

  it("puts the query in the title", async () => {
    expect((await meta({ q: "rate limit" })).title).toEqual({ absolute: '"rate limit" · Search' });
  });

  it("cuts a long query in the title", async () => {
    expect((await meta({ q: "x".repeat(200) })).title).toEqual({
      absolute: `"${"x".repeat(60)}…" · Search`,
    });
  });

  it("is not indexed", async () => {
    expect((await meta({ q: "x" })).robots).toEqual({ index: false, follow: true });
    expect((await meta({})).robots).toEqual({ index: false, follow: true });
  });
});

describe("search page, plain repositories (task 11.1)", () => {
  it("offers only the Repository facet, and no OKF controls, when no hit has OKF values", async () => {
    loadSearchPage.mockImplementation((state) =>
      Promise.resolve({
        status: "ok",
        state,
        query: "deploy",
        total: 1,
        hits: [
          {
            key: "1:docs/a.md",
            title: "Deploy",
            href: "/acme/api/docs/a",
            repoLabel: "acme/api",
            repoHref: "/acme/api",
            path: "docs/a.md",
            section: null,
            snippet: "How we deploy.",
            isPrivate: false,
            type: null,
            status: null,
            tags: [],
          },
        ],
        groups: buildFacetGroups(state, {
          repos: [{ owner: "acme", name: "api", count: 1 }],
          types: [],
          tags: [],
          statuses: [],
        }),
        active: [],
        paging: computePaging(state, 1, 1),
      }),
    );
    const out = await html({ q: "deploy" });
    expect(out).toContain('data-testid="facet-group-repo"');
    for (const kind of ["type", "tag", "status"]) {
      expect(out).not.toContain(`data-testid="facet-group-${kind}"`);
    }
    expect(out).not.toMatch(/okf/i);
    expect(out).not.toContain('data-testid="result-type"');
  });
});
