import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoDetail } from "@/server/queries";
import type { RepoPageData } from "@/server/repo-page";

const loadRepoPage = vi.fn<(owner: string, name: string) => Promise<RepoPageData>>();
vi.mock("@/server/repo-page", () => ({
  loadRepoPage: (owner: string, name: string) => loadRepoPage(owner, name),
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
};

function ok(over: Partial<RepoDetail> = {}) {
  return {
    status: "ok" as const,
    loadedAt: NOW,
    repo: { ...repo, ...over },
    readme: { status: "rendered" as const, html: "<h1>Hello</h1>" },
  };
}

async function html(owner = "acme", name = "api"): Promise<string> {
  return renderToStaticMarkup(await RepoPage({ params: Promise.resolve({ owner, repo: name }) }));
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
    });
    const out = await html();
    expect(out).toContain("Waiting for the first sync");
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
    generateMetadata({ params: Promise.resolve({ owner, repo: name }) });

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
