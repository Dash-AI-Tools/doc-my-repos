import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HIGHLIGHT_START } from "@docmyrepos/core/internal/search";
import {
  EMPTY_SEARCH_STATE,
  parseSearchParams,
  type SearchState,
} from "@docmyrepos/core/internal/search-params";

import { ConfigError } from "./config/errors";
import type { Db } from "./db/client";
import { documents, repos, type Heading } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { loadSearchPage, searchResultItem } from "./search-page";
import type { SearchHit } from "./queries";

const state = (over: Partial<SearchState> = {}): SearchState => ({
  ...EMPTY_SEARCH_STATE,
  q: "deployment",
  ...over,
});

function failingDb(error: unknown): Db {
  return {
    execute() {
      throw error;
    },
    select() {
      throw error;
    },
  } as unknown as Db;
}

function osError(code: string): Error {
  return Object.assign(new Error("connect failed to postgres://user:secret@10.1.2.3:5432/db"), {
    code,
  });
}

describe("loadSearchPage without a database", () => {
  it("is idle for an empty query and never opens a connection", async () => {
    const db = vi.fn(() => failingDb(new Error("must not be used")));
    expect(await loadSearchPage(EMPTY_SEARCH_STATE, { db })).toEqual({
      status: "idle",
      state: EMPTY_SEARCH_STATE,
    });
    expect(db).not.toHaveBeenCalled();
  });

  it("returns the error state and logs only a fixed message with the kind", async () => {
    const log = vi.fn();
    const view = await loadSearchPage(state({ q: "secret query text" }), {
      db: () => failingDb(osError("ECONNREFUSED")),
      log,
    });
    expect(view.status).toBe("error");
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("search_page.failed", {
      reason: "database error (ECONNREFUSED)",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|10\.1\.2\.3|postgres:/);
  });

  it("returns the error state when the runtime cannot be built", async () => {
    const log = vi.fn();
    const view = await loadSearchPage(state(), {
      db: () => {
        throw new ConfigError(["SYNC_SECRET: is not set"]);
      },
      log,
    });
    expect(view.status).toBe("error");
    expect(log).toHaveBeenCalledWith("search_page.failed", { reason: "ConfigError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNC_SECRET");
  });

  it("rethrows an unexpected error without logging it", async () => {
    const log = vi.fn();
    const bug = new TypeError("x is not a function");
    await expect(loadSearchPage(state(), { db: () => failingDb(bug), log })).rejects.toBe(bug);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("searchResultItem", () => {
  const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
    repo: { id: 7, owner: "acme", name: "api", visibility: "public", docsPath: "docs" },
    doc: {
      path: "docs/guides/setup.md",
      title: "Setup",
      description: null,
      type: null,
      tags: [],
      status: null,
      reserved: null,
    },
    rank: 1,
    snippet: `${HIGHLIGHT_START}x`,
    heading: null,
    ...over,
  });

  it("links to the document page, without an anchor when no heading matched", () => {
    expect(searchResultItem(hit())).toMatchObject({
      key: "7:docs/guides/setup.md",
      href: "/acme/api/docs/guides/setup",
      repoHref: "/acme/api",
      repoLabel: "acme/api",
      isPrivate: false,
      section: null,
    });
  });

  it("adds the best heading as an anchor and a section label", () => {
    const item = searchResultItem(
      hit({ heading: { depth: 2, text: "Deployment checks", slug: "deployment-checks" } }),
    );
    expect(item.href).toBe("/acme/api/docs/guides/setup#deployment-checks");
    expect(item.section).toBe("Deployment checks");
  });

  it("shows no type, status or tag chips for the reserved index.md and log.md (task 11.6)", () => {
    for (const reserved of ["index", "log"] as const) {
      const item = searchResultItem(
        hit({
          doc: {
            path: `docs/${reserved}.md`,
            title: "Reserved",
            description: null,
            type: "Log",
            tags: ["t"],
            status: "active",
            reserved,
          },
        }),
      );
      expect(item).toMatchObject({ type: null, status: null, tags: [] });
    }
    const typed = searchResultItem(
      hit({
        doc: {
          path: "docs/a.md",
          title: "A",
          description: null,
          type: "Log",
          tags: ["t"],
          status: "active",
          reserved: null,
        },
      }),
    );
    expect(typed).toMatchObject({ type: "Log", status: "active", tags: ["t"] });
  });

  it("skips the anchor of a depth-1 heading (the document's own title)", () => {
    const item = searchResultItem(hit({ heading: { depth: 1, text: "Setup", slug: "setup" } }));
    expect(item.href).toBe("/acme/api/docs/guides/setup");
    expect(item.section).toBeNull();
  });

  it("uses the renamed id for a slug that is a sensitive DOM name", () => {
    const item = searchResultItem(
      hit({ heading: { depth: 2, text: "Location", slug: "location" } }),
    );
    expect(item.href).toBe("/acme/api/docs/guides/setup#user-content-location");
  });

  it("encodes the document path and the anchor", () => {
    const item = searchResultItem(
      hit({
        doc: { ...hit().doc, path: "docs/100% done.md" },
        heading: { depth: 3, text: "Überblick", slug: "über-blick_1" },
      }),
    );
    expect(item.href).toBe("/acme/api/docs/100%25%20done#%C3%BCber-blick_1");
  });

  it("omits the anchor when the slug would not be an id on the doc page, keeping the section label", () => {
    const tooLong = "a".repeat(2000);
    for (const slug of ["a%b", "two words", "a/b", "<x>", "", "a#b", tooLong]) {
      const item = searchResultItem(hit({ heading: { depth: 3, text: "Odd section", slug } }));
      expect(item.href, JSON.stringify(slug.slice(0, 20))).toBe("/acme/api/docs/guides/setup");
      expect(item.section).toBe("Odd section");
    }
  });

  it("falls back to the repository page for a document outside the docs folder", () => {
    const item = searchResultItem(hit({ repo: { ...hit().repo, docsPath: null } }));
    expect(item.href).toBe("/acme/api");
  });

  it("flags private repositories and keeps OKF values", () => {
    const item = searchResultItem(
      hit({
        repo: { ...hit().repo, visibility: "private" },
        doc: { ...hit().doc, type: "Runbook", status: "draft", tags: ["a"] },
      }),
    );
    expect(item).toMatchObject({ isPrivate: true, type: "Runbook", status: "draft", tags: ["a"] });
  });
});

describeDb("loadSearchPage on a real database", () => {
  let t: TestDatabase;

  async function repo(
    githubId: number,
    owner: string,
    name: string,
    visibility: "public" | "private",
  ) {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner,
        name,
        visibility,
        defaultBranch: "main",
        docsPath: "docs",
        htmlUrl: `https://github.com/${owner}/${name}`,
      })
      .returning({ id: repos.id });
    if (row === undefined) throw new Error("insert failed");
    return row.id;
  }

  async function doc(
    repoId: number,
    path: string,
    title: string,
    body: string,
    extra: Partial<typeof documents.$inferInsert> = {},
  ) {
    await t.db.insert(documents).values({
      repoId,
      path,
      title,
      body,
      blobSha: `sha-${path}`,
      sizeBytes: body.length,
      ...extra,
    });
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    const api = await repo(1, "acme", "api", "public");
    const secret = await repo(2, "acme", "secret", "private");
    const headings: Heading[] = [
      { depth: 1, text: "Operations", slug: "operations" },
      { depth: 2, text: "Deployment checks", slug: "deployment-checks" },
    ];
    await doc(api, "docs/deployment.md", "Deployment", "Ship it.");
    await doc(api, "docs/ops.md", "Operations", "Runbook.", { headings });
    await doc(api, "docs/okf.md", "Release", "A deployment note.", {
      type: "Runbook",
      status: "draft",
      tags: ["infra"],
    });
    await doc(secret, "docs/private.md", "Private deploys", "Every deployment is logged.");
    for (let i = 1; i <= 25; i++) {
      await doc(
        api,
        `docs/log/entry-${String(i).padStart(2, "0")}.md`,
        `Entry ${i}`,
        "The changelog says so.",
      );
    }
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const load = (s: SearchState) => loadSearchPage(s, { db: () => t.db });

  it("returns hits ranked title first, with links, facets, filters and paging", async () => {
    const view = await load(state());
    expect(view.status).toBe("ok");
    if (view.status !== "ok") return;
    expect(view.total).toBe(4);
    // title (A) first, then the heading match (B), then the two body matches
    expect(view.hits.map((h) => h.title).slice(0, 2)).toEqual(["Deployment", "Operations"]);
    expect(view.hits[0]?.title).toBe("Deployment");
    expect(view.hits[0]?.href).toBe("/acme/api/docs/deployment");
    expect(view.hits[1]).toMatchObject({
      title: "Operations",
      href: "/acme/api/docs/ops#deployment-checks",
      section: "Deployment checks",
    });
    expect(view.hits.find((h) => h.title === "Private deploys")?.isPrivate).toBe(true);
    expect(view.hits.find((h) => h.title === "Release")).toMatchObject({
      type: "Runbook",
      status: "draft",
      tags: ["infra"],
    });
    // a body match is highlighted; a title-only match still has a plain snippet
    expect(view.hits.find((h) => h.title === "Release")?.snippet).toContain(HIGHLIGHT_START);
    expect(view.groups.map((g) => g.kind)).toEqual(["repo", "type", "tag", "status"]);
    expect(view.groups[0]?.options.map((o) => [o.label, o.count])).toEqual([
      ["acme/api", 3],
      ["acme/secret", 1],
    ]);
    expect(view.paging).toMatchObject({ from: 1, to: 4, total: 4, nextPage: null });
  });

  it("applies the repository filter to hits, facets and the total", async () => {
    const view = await load(state({ repos: ["ACME/Secret"] }));
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.hits.map((h) => h.title)).toEqual(["Private deploys"]);
    expect(view.total).toBe(1);
    // the repository facet still lists the other repository (disjunctive facets)
    expect(view.groups[0]?.options.map((o) => [o.value, o.selected, o.count])).toEqual([
      ["acme/secret", true, 1],
      ["acme/api", false, 3],
    ]);
    expect(view.active).toHaveLength(1);
  });

  it("hides the OKF groups when no hit has such values", async () => {
    const view = await load(state({ q: "ships" }));
    // no token "ships": no results at all
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.groups).toEqual([]);
    const plain = await load(state({ q: "ship" }));
    if (plain.status !== "ok") throw new Error("expected ok");
    expect(plain.hits.map((h) => h.title)).toEqual(["Deployment"]);
    expect(plain.groups.map((g) => g.kind)).toEqual(["repo"]);
  });

  it("pages through results", async () => {
    const first = await load(state({ q: "changelog" }));
    if (first.status !== "ok") throw new Error("expected ok");
    expect(first.total).toBe(25);
    expect(first.hits).toHaveLength(20);
    expect(first.paging).toMatchObject({
      from: 1,
      to: 20,
      lastPage: 2,
      nextPage: 2,
      prevPage: null,
    });
    const second = await load(state({ q: "changelog", page: 2 }));
    if (second.status !== "ok") throw new Error("expected ok");
    expect(second.hits).toHaveLength(5);
    expect(second.paging).toMatchObject({ from: 21, to: 25, nextPage: null, prevPage: 1 });
    const small = await load(state({ q: "changelog", limit: 10, page: 3 }));
    if (small.status !== "ok") throw new Error("expected ok");
    expect(small.hits).toHaveLength(5);
  });

  it("reports a page past the end with the real total, not as no results", async () => {
    const view = await load(state({ q: "changelog", page: 9 }));
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.hits).toEqual([]);
    expect(view.total).toBe(25);
    expect(view.paging).toMatchObject({ outOfRange: true, lastPage: 2, prevPage: 2 });
  });

  it("reports a page deeper than the query layer serves with the real total", async () => {
    const view = await load(state({ q: "changelog", page: 99_999 }));
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.hits).toEqual([]);
    expect(view.total).toBe(25);
    expect(view.paging.outOfRange).toBe(true);
  });

  it("returns an empty ok view for no matches, keeping the query", async () => {
    const view = await load(state({ q: "zzzznothing" }));
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view).toMatchObject({ query: "zzzznothing", total: 0, hits: [], groups: [] });
  });

  it("answers every kind of hostile query with an ok view", async () => {
    for (const q of [
      '"unclosed & | ! ( ',
      ")(",
      "-",
      "OR",
      "or or or",
      "<script>alert(1)</script>",
      "%",
      "'; drop table documents; --",
      "a".repeat(5000),
      "\\",
      "*:*",
    ]) {
      const view = await load(parseSearchParams({ q, repo: q, type: q, tag: q, status: q }));
      expect(view.status, q.slice(0, 20)).toBe("ok");
    }
  });
});
