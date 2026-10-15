import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReadModeTarget } from "@/components/read-mode-target";
import { buildDocsTree, type DocsTreeRow } from "@/lib/docs-tree";
import {
  countTocRows,
  filterDocsRows,
  parseTocFilters,
  type TocFilterState,
} from "@/lib/toc-filters";
import type { DocPageData, DocPageOk } from "@/server/doc-page";
import type { RepoDetail } from "@/server/queries";

const loadDocPage =
  vi.fn<
    (
      owner: string,
      name: string,
      segments: readonly string[],
      filters: TocFilterState,
    ) => Promise<DocPageData>
  >();
vi.mock("@/server/doc-page", () => ({
  loadDocPage: (
    owner: string,
    name: string,
    segments: readonly string[],
    _deps: unknown,
    filters: TocFilterState,
  ) => loadDocPage(owner, name, segments, filters),
}));

import DocPage, { dynamic, generateMetadata } from "./page";

/** The opening tag of the document bar, to read its classes. */
const barTag = (out: string): string =>
  out.match(/<div[^>]*data-testid="doc-bar"[^>]*>/)?.[0] ?? "";

const NOW = new Date("2026-10-10T12:00:00Z");

const repo: RepoDetail = {
  id: 1,
  githubId: 1,
  owner: "acme",
  name: "api",
  description: "API",
  htmlUrl: "https://github.com/acme/api",
  visibility: "public",
  isAllowed: true,
  isOkf: false,
  okfVersion: null,
  syncStatus: "ok",
  syncError: null,
  lastSyncedAt: new Date("2026-10-10T11:00:00Z"),
  docCount: 3,
  defaultBranch: "main",
  docsPath: "docs",
  readme: null,
  codeownersPath: null,
  codeOwners: [],
  syncWarnings: [],
};

function docRow(path: string, title: string): DocsTreeRow {
  return { path, title, description: null, type: null, tags: [], status: null, reserved: null };
}

const tree = buildDocsTree(
  [
    docRow("docs/guides/setup.md", "Setup"),
    docRow("docs/guides/tuning.md", "Tuning"),
    docRow("docs/ref.md", "Ref"),
  ],
  "docs",
);

function ok(over: Partial<DocPageOk> = {}): DocPageOk {
  return {
    status: "ok",
    repo,
    doc: {
      id: 1,
      repoId: 1,
      path: "docs/guides/setup.md",
      blobSha: "x",
      sizeBytes: 1,
      title: "Setup",
      description: "How to set up.",
      type: null,
      tags: [],
      status: null,
      headings: [],
      frontmatter: {},
      reserved: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    body: {
      status: "rendered",
      html: '<h2 id="install">Install</h2><p>Body</p>',
      hideTitleHeading: false,
    },
    notice: null,
    outline: [{ text: "Install", id: "install", depth: 2, children: [] }],
    tree,
    navTree: tree,
    toc: null,
    previous: null,
    next: null,
    crumbs: [{ label: "guides", href: null }],
    sourceUrl: "https://github.com/acme/api/blob/main/docs/guides/setup.md",
    url: "/acme/api/docs/guides/setup",
    loadedAt: NOW,
    ...over,
  };
}

const params = (path: string[], owner = "acme", repoName = "api") =>
  Promise.resolve({ owner, repo: repoName, path });

async function html(
  path = ["guides", "setup"],
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  return renderToStaticMarkup(
    await DocPage({ params: params(path), searchParams: Promise.resolve(searchParams) }),
  );
}

beforeEach(() => {
  loadDocPage.mockReset();
});

describe("document page", () => {
  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders the title, description, source link, body, outline, pager and table of contents", async () => {
    loadDocPage.mockResolvedValue(
      ok({
        previous: {
          ...docRow("docs/ref.md", "Ref"),
          kind: "doc",
          stem: "ref",
          fileName: "ref.md",
          reserved: null,
        },
        next: {
          ...docRow("docs/guides/tuning.md", "Tuning"),
          kind: "doc",
          stem: "guides/tuning",
          fileName: "tuning.md",
          reserved: null,
        },
      }),
    );
    const out = await html();
    expect(out).toMatch(/<h1[^>]*id="doc-title"[^>]*>Setup<\/h1>/);
    expect(out).toContain("How to set up.");
    expect(out).toContain('href="https://github.com/acme/api/blob/main/docs/guides/setup.md"');
    expect(out).toContain("View source on GitHub");
    expect(out).toContain('<h2 id="install">Install</h2>');
    expect(out).toContain('aria-label="On this page"');
    expect(out).toContain('href="#install"');
    expect(out).toContain('rel="prev"');
    expect(out).toContain('href="/acme/api/docs/ref"');
    expect(out).toContain('rel="next"');
    expect(out).toContain('href="/acme/api/docs/guides/tuning"');
    expect(out).toContain('aria-label="Documentation"');
    expect(out).toContain('aria-current="page"');
    // keyboard order: document bar, breadcrumb (in the content column), document, pager, then the
    // headings and the structure (the lists a visitor without JavaScript uses)
    const order = [
      'data-testid="doc-bar"',
      'aria-label="Breadcrumb"',
      'data-testid="doc-article"',
      'data-testid="doc-pager"',
      'data-testid="doc-sidebar"',
      'data-testid="doc-nav"',
    ].map((marker) => out.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // not enhanced yet: the page says so and the bar keeps its height without showing
    expect(out).toContain('data-enhanced="false"');
    expect(barTag(out)).toContain("invisible");
    // the headings exist twice (menu below xl, column from xl), the structure once
    expect(out.match(/aria-label="On this page"/g)).toHaveLength(2);
    expect(out).toContain('data-testid="outline-menu"');
    expect(out.match(/data-testid="docs-tree"/g)).toHaveLength(1);
    expect(out).not.toContain("<aside");
  });

  it("leaves out the outline of a document with no headings", async () => {
    loadDocPage.mockResolvedValue(ok({ outline: [] }));
    const out = await html();
    expect(out).not.toContain('aria-label="On this page"');
    // only the hamburger is left in the bar, which is then hidden from lg
    expect(out).toContain('data-testid="doc-nav-toggle"');
    expect(barTag(out)).toMatch(/class="[^"]*\blg:hidden\b/);
    expect(barTag(out)).not.toContain("xl:hidden");
  });

  it("leaves out the source link when the stored path is not linkable", async () => {
    loadDocPage.mockResolvedValue(ok({ sourceUrl: null }));
    expect(await html()).not.toContain("View source on GitHub");
  });

  it("shows a notice and plain text when rendering failed", async () => {
    loadDocPage.mockResolvedValue(
      ok({ body: { status: "plain", text: "# raw" }, notice: "Shown as plain text." }),
    );
    const out = await html();
    expect(out).toContain("Shown as plain text.");
    expect(out).toContain("# raw");
  });

  it("calls notFound (HTTP 404) for an unknown document", async () => {
    loadDocPage.mockResolvedValue({ status: "not_found" });
    await expect(html(["nope"])).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("redirects to the canonical address", async () => {
    loadDocPage.mockResolvedValue({ status: "redirect", to: "/acme/api/docs/guides/setup" });
    await expect(html(["GUIDES", "SETUP"])).rejects.toMatchObject({
      digest: expect.stringContaining("/acme/api/docs/guides/setup"),
    });
  });

  it("renders the in-page error state for an expected failure", async () => {
    loadDocPage.mockResolvedValue({ status: "error", loadedAt: NOW });
    const out = await html();
    expect(out).toContain("This repository could not be loaded");
    expect(out).toContain('href="/acme/api/docs/guides/setup"');
  });

  it("lets an unexpected error reach the error boundary", async () => {
    loadDocPage.mockRejectedValue(new TypeError("bug"));
    await expect(html()).rejects.toThrow("bug");
  });

  it("percent-decodes the address once before loading", async () => {
    loadDocPage.mockResolvedValue({ status: "not_found" });
    await expect(html(["special", "100%25%20done"])).rejects.toBeDefined();
    expect(loadDocPage).toHaveBeenCalledWith(
      "acme",
      "api",
      ["special", "100% done"],
      parseTocFilters({}),
    );
  });

  it("answers not found for a malformed escape without loading", async () => {
    await expect(html(["%E0%A4%A"])).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(loadDocPage).not.toHaveBeenCalled();
  });
});

describe("generateMetadata", () => {
  const meta = (path: string[], owner = "acme", repoName = "api") =>
    generateMetadata({
      params: params(path, owner, repoName),
      searchParams: Promise.resolve({}),
    });

  it("titles the page with the stored title and owner/name, and sets the canonical URL", async () => {
    loadDocPage.mockResolvedValue(ok());
    expect(await meta(["guides", "setup"], "ACME", "API")).toEqual({
      title: { absolute: "Setup · acme/api" },
      description: "How to set up.",
      alternates: { canonical: "/acme/api/docs/guides/setup" },
    });
  });

  it("leaves the description out, so the site description is inherited, when the document has none", async () => {
    const data = ok();
    loadDocPage.mockResolvedValue({ ...data, doc: { ...data.doc, description: null } });
    const result = await meta(["guides", "setup"]);
    expect("description" in result).toBe(false);
  });

  it("uses the segments as Next.js passes them to metadata (already decoded)", async () => {
    loadDocPage.mockResolvedValue(ok());
    await meta(["special", "100% done"]);
    expect(loadDocPage).toHaveBeenCalledWith(
      "acme",
      "api",
      ["special", "100% done"],
      parseTocFilters({}),
    );
  });

  it("never echoes an address that names nothing", async () => {
    loadDocPage.mockResolvedValue({ status: "not_found" });
    expect(await meta(["<script>"], "search", "x")).toEqual({
      title: "Document not found",
    });
  });

  it("uses the plain site title for a redirect and the in-page error state", async () => {
    loadDocPage.mockResolvedValue({ status: "error", loadedAt: NOW });
    expect(await meta(["a"])).toEqual({});
    loadDocPage.mockResolvedValue({ status: "redirect", to: "/x" });
    expect(await meta(["a"])).toEqual({});
  });
});

describe("document page, OKF filters (tasks 11.1 to 11.3)", () => {
  const typed = (path: string, title: string, over: Partial<DocsTreeRow>): DocsTreeRow => ({
    ...docRow(path, title),
    ...over,
  });
  const rows: DocsTreeRow[] = [
    typed("docs/guides/setup.md", "Setup", { type: "Concept", tags: ["core"], status: "active" }),
    typed("docs/guides/tuning.md", "Tuning", { type: "Table", status: "draft" }),
    typed("docs/ref.md", "Ref", { type: "Concept", status: "active" }),
  ];
  const okfRepo: RepoDetail = { ...repo, isOkf: true, okfVersion: "0.2" };

  function okfPage(filters: TocFilterState): DocPageOk {
    return ok({
      repo: okfRepo,
      tree: buildDocsTree(rows, "docs"),
      // The sidebar keeps the page being read (docs/guides/tuning.md) even when it is filtered out.
      navTree: buildDocsTree(filterDocsRows(rows, filters, "docs/guides/tuning.md"), "docs"),
      toc: {
        state: filters,
        facets: {
          types: [
            { value: "Concept", count: 2 },
            { value: "Table", count: 1 },
          ],
          tags: [{ value: "core", count: 1 }],
          statuses: [
            { value: "active", count: 2 },
            { value: "draft", count: 1 },
          ],
        },
        counts: countTocRows(rows, filters),
      },
      doc: { ...ok().doc, path: "docs/guides/tuning.md", title: "Tuning" },
      url: "/acme/api/docs/guides/tuning",
    });
  }

  it("passes the URL's filters to the loader", async () => {
    loadDocPage.mockResolvedValue(okfPage(parseTocFilters({})));
    await html(["guides", "tuning"], { type: "Table", status: ["draft", "active"] });
    expect(loadDocPage.mock.calls[0]?.[3]).toMatchObject({
      types: ["Table"],
      statuses: ["active", "draft"],
    });
  });

  it("narrows the sidebar, keeps the current page and the filters in every link", async () => {
    const filters = parseTocFilters({ type: "Concept" });
    loadDocPage.mockResolvedValue(okfPage(filters));
    const out = await html(["guides", "tuning"], { type: "Concept" });
    expect(out).toContain("2 of 3 documents match");
    expect(out).toContain('href="/acme/api/docs/guides/setup?type=Concept"');
    expect(out).toContain('href="/acme/api/docs/ref?type=Concept"');
    // The page being read stays, marked as current, though it is a Table.
    expect(out).toContain('href="/acme/api/docs/guides/tuning?type=Concept"');
    expect(out).toContain('aria-current="page"');
    // The chips link to THIS document with the value toggled.
    expect(out).toContain('href="/acme/api/docs/guides/tuning?type=Concept&amp;type=Table"');
    expect(out).toContain('data-testid="okf-filter-clear"');
  });

  it("keeps the filters when redirecting to the canonical address", async () => {
    loadDocPage.mockResolvedValue({ status: "redirect", to: "/acme/api/docs/guides/setup" });
    await expect(html(["GUIDES", "SETUP"], { type: "Concept", tag: "core" })).rejects.toMatchObject(
      { digest: expect.stringContaining("/acme/api/docs/guides/setup?tag=core&type=Concept") },
    );
  });

  it("shows no OKF UI for a plain repository, whatever the URL says", async () => {
    loadDocPage.mockResolvedValue(ok());
    const out = await html(["guides", "setup"], { type: "Concept", tag: "x", status: "draft" });
    expect(out).not.toMatch(/OKF/);
    expect(out).not.toContain("okf-");
    expect(out).not.toContain("Filter documents");
    expect(out).not.toContain("?type=");
    expect(out).toContain('aria-label="Documentation"');
  });
});

describe("document page, OKF metadata, notices and change log (tasks 11.4 to 11.6)", () => {
  const okfRepo: RepoDetail = { ...repo, isOkf: true, okfVersion: "0.2" };
  const base = ok();

  function page(
    over: {
      repo?: RepoDetail;
      doc?: Partial<DocPageOk["doc"]>;
      loadedAt?: Date;
    } = {},
  ): DocPageOk {
    return ok({
      repo: over.repo ?? okfRepo,
      doc: { ...base.doc, ...over.doc },
      ...(over.loadedAt === undefined ? {} : { loadedAt: over.loadedAt }),
    });
  }

  const typedDoc = {
    type: "Runbook",
    tags: ["database"],
    status: "active",
    description: "Switch to the replica.",
    frontmatter: {
      type: "Runbook",
      tags: ["database"],
      status: "active",
      description: "Switch to the replica.",
      owner_team: "platform",
    },
  };

  it("shows the metadata card between the header and the body in an OKF repository", async () => {
    loadDocPage.mockResolvedValue(page({ doc: typedDoc }));
    const out = await html();
    expect(out).toContain('data-testid="okf-metadata"');
    expect(out).toContain("Document metadata");
    expect(out).toContain('href="/acme/api?type=Runbook"');
    expect(out).toContain("owner_team");
    const header = out.indexOf('data-testid="doc-header"');
    const card = out.indexOf('data-testid="okf-metadata"');
    const body = out.indexOf('data-testid="doc-body"');
    expect(header).toBeLessThan(card);
    expect(card).toBeLessThan(body);
  });

  it("shows the description once: in the card, not also under the title", async () => {
    loadDocPage.mockResolvedValue(page({ doc: typedDoc }));
    const out = await html();
    expect(out).not.toContain('data-testid="doc-description"');
    expect(out.split("Switch to the replica.")).toHaveLength(2);
  });

  it("shows a type-only document with just its type", async () => {
    loadDocPage.mockResolvedValue(
      page({ doc: { type: "Note", description: null, frontmatter: { type: "Note" } } }),
    );
    const out = await html();
    expect(out).toContain('data-testid="okf-row-type"');
    expect(out).not.toContain('data-testid="okf-row-status"');
    expect(out).not.toContain('data-testid="okf-other-fields"');
  });

  it("shows no card for an untyped document with nothing to show", async () => {
    loadDocPage.mockResolvedValue(
      page({ doc: { description: null, frontmatter: {}, type: null } }),
    );
    expect(await html()).not.toContain('data-testid="okf-metadata"');
  });

  it("shows no OKF UI at all for a plain repository, whatever the frontmatter says", async () => {
    loadDocPage.mockResolvedValue(
      page({
        repo,
        doc: {
          ...typedDoc,
          status: "deprecated",
          frontmatter: { ...typedDoc.frontmatter, status: "deprecated", stale_after: "2001-01-01" },
        },
      }),
    );
    const out = await html();
    expect(out).not.toContain("okf-");
    expect(out).not.toContain("Document metadata");
    expect(out).not.toContain("deprecated");
    // the header description stays where it was
    expect(out).toContain('data-testid="doc-description"');
  });

  it("shows a deprecation notice above the body", async () => {
    loadDocPage.mockResolvedValue(
      page({ doc: { ...typedDoc, status: "deprecated", frontmatter: { type: "Runbook" } } }),
    );
    const out = await html();
    const notice = out.indexOf('data-testid="okf-notice-deprecated"');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(out.indexOf('data-testid="doc-body"'));
    expect(notice).toBeGreaterThan(out.indexOf('data-testid="okf-metadata"'));
  });

  it("uses the load time as now: a past stale_after warns, a future one does not", async () => {
    const frontmatter = { type: "Runbook", stale_after: "2026-10-01" };
    loadDocPage.mockResolvedValue(page({ doc: { ...typedDoc, frontmatter } }));
    expect(await html()).toContain("it was due for review on");
    // the same document, viewed before the date
    loadDocPage.mockResolvedValue(
      page({ doc: { ...typedDoc, frontmatter }, loadedAt: new Date("2026-09-01T00:00:00Z") }),
    );
    const early = await html();
    expect(early).not.toContain("okf-notice-stale");
    expect(early).toContain("(in 30 days)");
  });

  it("frames the reserved log.md of an OKF repository as a change log, with no metadata card", async () => {
    loadDocPage.mockResolvedValue(
      page({
        doc: {
          path: "docs/log.md",
          title: "Log",
          reserved: "log",
          type: "Note",
          frontmatter: { type: "Note", owner_team: "x" },
        },
      }),
    );
    const out = await html(["log"]);
    expect(out).toContain('data-testid="change-log"');
    expect(out).toContain('data-testid="change-log-badge"');
    expect(out).not.toContain('data-testid="okf-metadata"');
    expect(out.indexOf('data-testid="change-log"')).toBeLessThan(
      out.indexOf('data-testid="doc-body"'),
    );
  });

  it("shows the reserved index.md as a plain page: no card, no change log", async () => {
    loadDocPage.mockResolvedValue(
      page({
        doc: {
          path: "docs/guides/index.md",
          title: "Guides",
          reserved: "index",
          type: null,
          frontmatter: { okf_version: "0.2", description: "Folder summary." },
        },
      }),
    );
    const out = await html(["guides", "index"]);
    expect(out).not.toContain('data-testid="okf-metadata"');
    expect(out).not.toContain('data-testid="change-log"');
  });

  it("raises no deprecated, draft or stale notice on the reserved index.md and log.md", async () => {
    for (const [reserved, path, status] of [
      ["index", "docs/guides/index.md", "draft"],
      ["index", "docs/index.md", "deprecated"],
      ["log", "docs/log.md", "deprecated"],
    ] as const) {
      loadDocPage.mockResolvedValue(
        page({
          doc: {
            path,
            title: "Reserved",
            reserved,
            type: null,
            status,
            frontmatter: { status, stale_after: "2001-01-01" },
          },
        }),
      );
      const out = await html(
        path
          .replace(/^docs\//, "")
          .replace(/\.md$/, "")
          .split("/"),
      );
      expect(out, path).not.toContain("okf-notice");
      expect(out, path).not.toContain("okf-metadata");
    }
  });

  it("still raises the notices on a typed document with the same keys", async () => {
    loadDocPage.mockResolvedValue(
      page({
        doc: {
          ...typedDoc,
          status: "draft",
          frontmatter: { type: "Runbook", status: "draft", stale_after: "2001-01-01" },
        },
      }),
    );
    const out = await html();
    expect(out).toContain('data-testid="okf-notice-draft"');
    expect(out).toContain('data-testid="okf-notice-stale"');
  });

  it("renders a log.md of a plain repository as an ordinary page", async () => {
    loadDocPage.mockResolvedValue(
      page({ repo, doc: { path: "docs/log.md", title: "Log", reserved: "log" } }),
    );
    const out = await html(["log"]);
    expect(out).not.toContain("change-log");
    expect(out).not.toContain("Change log");
  });
});

describe("document page read mode markup", () => {
  it("marks the parts read mode hides, and the article that takes focus", async () => {
    loadDocPage.mockResolvedValue(ok({ previous: null, next: null }));
    const out = await html();
    expect(out).toMatch(/data-testid="doc-breadcrumb"[^>]*data-read-hide/);
    expect(out).toMatch(/data-testid="doc-bar"[^>]*data-read-hide/);
    expect(out).toMatch(/data-testid="doc-nav-wrap"[^>]*data-read-hide/);
    expect(out).toMatch(/data-testid="doc-sidebar"[^>]*data-read-hide/);
    expect(out).toMatch(
      /<div[^>]*data-read-hide[^>]*>(?:(?!<\/div>)[\s\S])*data-testid="doc-source-path"/,
    );
    expect(out).toMatch(/<article[^>]*data-read-article[^>]*tabindex="-1"/);
    expect(out).toMatch(/class="[^"]*\breader-content\b/);
    expect(out).toMatch(/class="[^"]*\breader-grid\b/);
  });
});

describe("document page read mode target", () => {
  it("renders the marker that makes the page readable", async () => {
    loadDocPage.mockResolvedValue(ok({ previous: null, next: null }));
    const tree = await DocPage({
      params: params(["guides", "setup"]),
      searchParams: Promise.resolve({}),
    });
    expect(containsElement(tree, ReadModeTarget)).toBe(true);
  });
});

/** Whether an element tree contains an element of this type anywhere below `node`. */
function containsElement(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => containsElement(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return false;
  if (node.type === type) return true;
  return containsElement(node.props.children, type);
}
