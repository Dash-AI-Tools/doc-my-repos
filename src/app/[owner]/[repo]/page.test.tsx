import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildDocsTree, type DocsTreeRow } from "@/lib/docs-tree";
import {
  countTocRows,
  filterDocsRows,
  parseTocFilters,
  type TocData,
  type TocFilterState,
} from "@/lib/toc-filters";
import type { RepoDetail } from "@/server/queries";
import type { RepoPageData } from "@/server/repo-page";

const loadRepoPage =
  vi.fn<(owner: string, name: string, filters: TocFilterState) => Promise<RepoPageData>>();
vi.mock("@/server/repo-page", () => ({
  loadRepoPage: (owner: string, name: string, _deps: unknown, filters: TocFilterState) =>
    loadRepoPage(owner, name, filters),
}));

import RepoPage, { dynamic, generateMetadata } from "./page";

const NOW = new Date("2026-10-10T12:00:00Z");

const repo: RepoDetail = {
  id: 1,
  githubId: 1,
  owner: "acme",
  name: "api",
  description: "API",
  htmlUrl: "https://github.com/acme/api",
  visibility: "public" as const,
  isAllowed: true,
  isOkf: false,
  okfVersion: null,
  syncStatus: "ok" as const,
  syncError: null,
  lastSyncedAt: new Date("2026-10-10T11:00:00Z"),
  docCount: 3,
  defaultBranch: "main",
  docsPath: "docs",
  readme: { path: "README.md", markdown: "# x", sha: null },
  codeownersPath: ".github/CODEOWNERS",
  codeOwners: [
    {
      position: 0,
      pattern: "*",
      owners: [{ handle: "@alice", kind: "user" as const }],
      sourcePath: ".github/CODEOWNERS",
    },
  ],
  syncWarnings: [],
};

function docRow(path: string, title: string): DocsTreeRow {
  return { path, title, description: null, type: null, tags: [], status: null, reserved: null };
}

const tree = buildDocsTree(
  [
    docRow("docs/guides/setup.md", "Setup"),
    docRow("docs/guides/advanced/tuning.md", "Tuning"),
    docRow("docs/reference/endpoints.md", "Endpoints"),
  ],
  "docs",
);

function ok(over: Partial<RepoDetail> = {}) {
  return {
    status: "ok" as const,
    loadedAt: NOW,
    repo: { ...repo, ...over },
    readme: { status: "rendered" as const, html: "<h1>Hello</h1>" },
    tree,
    toc: null,
    lastRun: null,
  };
}

async function html(
  owner = "acme",
  name = "api",
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  return renderToStaticMarkup(
    await RepoPage({
      params: Promise.resolve({ owner, repo: name }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

beforeEach(() => {
  loadRepoPage.mockReset();
});

describe("repository page", () => {
  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders the header, README, documentation slot and code owners", async () => {
    loadRepoPage.mockResolvedValue(ok());
    const out = await html();
    expect(out).toMatch(/<h1[^>]*>.*api<\/h1>/);
    expect(out).toContain("View on GitHub");
    expect(out).toContain('id="readme-heading"');
    expect(out).toContain("<h1>Hello</h1>");
    expect(out).toContain('aria-label="Documentation"');
    expect(out).toContain("3 documents");
    // the table of contents: folders and titles, linking to the document pages
    expect(out).toContain('href="/acme/api/docs/guides/setup"');
    expect(out).toContain('href="/acme/api/docs/guides/advanced/tuning"');
    expect(out).toContain('id="code-owners-heading"');
    expect(out).toContain("@alice");
    // sidebar order: documentation navigation before the code owners
    expect(out.indexOf('aria-label="Documentation"')).toBeLessThan(
      out.indexOf('id="code-owners-heading"'),
    );
    // no complementary landmark nested in <main>
    expect(out).not.toContain("<aside");
  });

  it("shows the README empty state and still renders the rest", async () => {
    loadRepoPage.mockResolvedValue({ ...ok(), readme: { status: "missing" as const } });
    const out = await html();
    expect(out).toContain("No README found");
    expect(out).toContain('aria-label="Documentation"');
    expect(out).toContain("@alice");
  });

  it("says 'after the first sync' instead of empty states for a never-synced repository", async () => {
    loadRepoPage.mockResolvedValue({
      ...ok({
        syncStatus: "pending",
        lastSyncedAt: null,
        docCount: 0,
        codeOwners: [],
        readme: null,
      }),
      readme: { status: "missing" as const },
      tree: buildDocsTree([], null),
    });
    const out = await html();
    expect(out).toContain("Waiting for the first sync");
    expect(out).toContain("The table of contents appears here after the first sync.");
    expect(out).not.toContain("No documentation files found");
    expect(out).toContain("The README appears here after the first sync.");
    expect(out).toContain("Code owners appear here after the first sync.");
    expect(out).not.toContain("No README found");
  });

  it("calls notFound (HTTP 404) for an unknown repository", async () => {
    loadRepoPage.mockResolvedValue({ status: "not_found" });
    await expect(html()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("redirects to the stored spelling", async () => {
    loadRepoPage.mockResolvedValue(ok());
    await expect(html("ACME", "API")).rejects.toMatchObject({
      digest: expect.stringContaining("/acme/api"),
    });
  });

  it("renders the in-page error state for an expected failure", async () => {
    loadRepoPage.mockResolvedValue({ status: "error", loadedAt: NOW });
    const out = await html();
    expect(out).toContain("This repository could not be loaded");
    expect(out).toContain('href="/acme/api"');
  });

  it("lets an unexpected error reach the error boundary", async () => {
    loadRepoPage.mockRejectedValue(new TypeError("bug"));
    await expect(html()).rejects.toThrow("bug");
  });
});

describe("generateMetadata", () => {
  const meta = (owner: string, name: string) =>
    generateMetadata({
      params: Promise.resolve({ owner, repo: name }),
      searchParams: Promise.resolve({}),
    });

  it("titles the page with the stored owner/name", async () => {
    loadRepoPage.mockResolvedValue(ok());
    expect(await meta("ACME", "API")).toEqual({ title: "acme/api · DocMyRepos" });
  });

  it("never echoes an address that is not a repository", async () => {
    loadRepoPage.mockResolvedValue({ status: "not_found" });
    expect(await meta("search", "<script>")).toEqual({
      title: "Repository not found · DocMyRepos",
    });
  });

  it("uses the plain site title for the in-page error state", async () => {
    loadRepoPage.mockResolvedValue({ status: "error", loadedAt: NOW });
    expect(await meta("acme", "api")).toEqual({ title: "DocMyRepos" });
  });
});

describe("repository page, OKF filters (tasks 11.1 to 11.3)", () => {
  const typed = (path: string, title: string, over: Partial<DocsTreeRow>): DocsTreeRow => ({
    ...docRow(path, title),
    ...over,
  });
  const rows: DocsTreeRow[] = [
    typed("docs/index.md", "Overview", { reserved: "index" }),
    typed("docs/guides/setup.md", "Setup", { type: "Concept", tags: ["core"], status: "active" }),
    typed("docs/guides/tuning.md", "Tuning", { type: "concept", tags: ["core"], status: "draft" }),
    typed("docs/reference/endpoints.md", "Endpoints", { type: "Table", status: "active" }),
  ];

  function okfData(filters: TocFilterState, over: Partial<RepoDetail> = {}) {
    const toc: TocData = {
      state: filters,
      facets: {
        types: [
          { value: "Concept", count: 1 },
          { value: "Table", count: 1 },
          { value: "concept", count: 1 },
        ],
        tags: [{ value: "core", count: 2 }],
        statuses: [
          { value: "active", count: 2 },
          { value: "draft", count: 1 },
        ],
      },
      counts: countTocRows(rows, filters),
    };
    return {
      ...ok({ isOkf: true, okfVersion: "0.2", ...over }),
      tree: buildDocsTree(filterDocsRows(rows, filters), "docs"),
      toc,
    };
  }

  it("parses the filters of the URL and passes them to the loader", async () => {
    loadRepoPage.mockResolvedValue(okfData(parseTocFilters({})));
    await html("acme", "api", { type: ["Table", "Concept"], tag: "core", status: "draft", q: "x" });
    const state = loadRepoPage.mock.calls[0]?.[2];
    expect(state).toMatchObject({
      types: ["Concept", "Table"],
      tags: ["core"],
      statuses: ["draft"],
      repos: [],
      q: "",
    });
  });

  it("shows the badge, the filter groups and chips with counts for an OKF repository", async () => {
    loadRepoPage.mockResolvedValue(okfData(parseTocFilters({})));
    const out = await html();
    expect(out).toContain('data-testid="okf-badge"');
    expect(out).toContain("OKF v0.2");
    expect(out).toContain('data-testid="okf-filters"');
    for (const group of ["type", "tag", "status"]) {
      expect(out).toContain(`data-testid="okf-filter-${group}"`);
    }
    // Chips link to this page with the value toggled; case variants are two chips.
    expect(out).toContain('href="/acme/api?type=Concept"');
    expect(out).toContain('href="/acme/api?type=concept"');
    expect(out).toContain('href="/acme/api?type=Table"');
    expect(out).toContain('href="/acme/api?tag=core"');
    expect(out).toContain('href="/acme/api?status=draft"');
    // Not filtered: no summary, no clear link, plain document links.
    expect(out).not.toContain("okf-filter-clear");
    expect(out).toContain('href="/acme/api/docs/guides/setup"');
  });

  it("narrows the tree, marks the selection, shows the summary and keeps the filters in links", async () => {
    const filters = parseTocFilters({ type: "Concept", tag: "core" });
    loadRepoPage.mockResolvedValue(okfData(filters));
    const out = await html("acme", "api", { type: "Concept", tag: "core" });
    expect(out).toContain("1 of 3 documents match");
    expect(out).toContain('href="/acme/api/docs/guides/setup?tag=core&amp;type=Concept"');
    expect(out).not.toContain("/docs/guides/tuning");
    expect(out).not.toContain("/docs/reference/endpoints");
    expect(out).toContain(", selected, press to remove this filter");
    expect(out).toContain('aria-current="true"');
    // Toggling a selected chip removes only that value; the clear link removes all.
    expect(out).toContain('href="/acme/api?tag=core"');
    expect(out).toContain('href="/acme/api?type=Concept"');
    expect(out).toContain('data-testid="okf-filter-clear"');
  });

  it("says nothing matches, with a way out, when the selection matches no document", async () => {
    const filters = parseTocFilters({ type: "Runbook" });
    loadRepoPage.mockResolvedValue(okfData(filters));
    const out = await html("acme", "api", { type: "Runbook" });
    expect(out).toContain("No documents match these filters");
    expect(out).toContain("0 of 3 documents match");
    // One clear link, in the message (the filter summary leaves its own out).
    expect(out).toContain('data-testid="docs-nav-no-match"');
    expect(out).not.toContain('data-testid="okf-filter-clear"');
    expect(out.match(/Clear filters/g)).toHaveLength(1);
    expect(out).not.toContain("No documentation files found");
    // The selected value is listed (count 0) so it can be removed.
    expect(out).toContain('href="/acme/api"');
  });

  it("keeps the filters when redirecting to the stored spelling", async () => {
    loadRepoPage.mockResolvedValue(okfData(parseTocFilters({ type: "Concept" })));
    await expect(html("ACME", "API", { type: "Concept" })).rejects.toMatchObject({
      digest: expect.stringContaining("/acme/api?type=Concept"),
    });
  });

  it("shows no OKF UI at all for a plain repository, even when the URL carries filters", async () => {
    // A plain repository: the loader returns toc null, whatever the URL says; its documents may
    // have a `type` (stale data) and still must not get chips.
    loadRepoPage.mockResolvedValue({
      ...ok({ isOkf: false, okfVersion: null }),
      tree: buildDocsTree(rows, "docs"),
      toc: null,
    });
    for (const params of [{}, { type: "Concept", tag: "core", status: "draft" }]) {
      const out = await html("acme", "api", params);
      expect(out).not.toContain("okf-badge");
      expect(out).not.toContain("okf-filter");
      expect(out).not.toContain("Filter documents");
      expect(out).not.toMatch(/OKF/);
      expect(out).not.toContain("Clear filters");
      expect(out).not.toContain("No documents match");
      // The whole tree, no filter query on its links.
      expect(out).toContain('href="/acme/api/docs/guides/setup"');
      expect(out).toContain('href="/acme/api/docs/reference/endpoints"');
      expect(out).not.toContain("?type=");
    }
  });
});
