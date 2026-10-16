import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDocsTree, flattenDocsTree } from "../../lib/docs-tree";
import { docPathCandidates } from "../../lib/routes";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import {
  codeOwners,
  docComments,
  documents,
  repos,
  syncRuns,
  type SyncRepoResult,
} from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  countDocComments,
  countDocs,
  findAssetRepo,
  getAdjacentDocs,
  getCommentDocument,
  getCommentStates,
  getCommentTarget,
  getCommentThread,
  getDocPaths,
  getDocsTree,
  getDocumentByPath,
  getRepo,
  getRepoFacets,
  getRepoSyncInfo,
  getSyncStatus,
  listCodeOwners,
  listCommentsForModeration,
  listDocComments,
  listRepos,
  NOT_QUERIES,
  QUERY_FUNCTIONS,
  SEARCH_VECTOR_READERS,
  searchDocuments,
  searchFacets,
} from "./index";
import {
  activeRepoVisibility,
  allowAllRepos,
  allowedReposOnly,
  publicReposOnly,
  type QueryOptions,
  type RepoVisibilityFilter,
} from "./visibility";

const QUERIES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("query registry", () => {
  it("registers every exported function of src/server/queries", async () => {
    const registered = new Set<unknown>(Object.values(QUERY_FUNCTIONS));
    const modules = readdirSync(QUERIES_DIR).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    );
    expect(modules).toEqual(expect.arrayContaining(["documents.ts", "repos.ts", "assets.ts"]));
    const missing: string[] = [];
    for (const file of modules) {
      const mod = (await import(`./${file.replace(/\.tsx?$/, "")}`)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        if (registered.has(value) || NOT_QUERIES.has(name)) continue;
        missing.push(`${file}: ${name}`);
      }
    }
    expect(missing, "export it as a query in QUERY_FUNCTIONS (index.ts)").toEqual([]);
  });

  it("uses the allow-all filter by default", () => {
    expect(activeRepoVisibility).toBe(allowedReposOnly);
  });
});

type Seed = {
  handbook: number;
  secret: number;
  empty: number;
  big: number;
  /** A thread root and its reply on the private repository's document. */
  secretRoot: number;
  secretReply: number;
};

async function insertRepo(
  db: Db,
  values: Partial<typeof repos.$inferInsert> &
    Pick<typeof repos.$inferInsert, "githubId" | "owner" | "name" | "visibility">,
): Promise<number> {
  const [row] = await db
    .insert(repos)
    .values({
      defaultBranch: "main",
      htmlUrl: `https://github.com/${values.owner}/${values.name}`,
      ...values,
    })
    .returning({ id: repos.id });
  if (row === undefined) throw new Error("insert failed");
  return row.id;
}

function doc(
  repoId: number,
  path: string,
  title: string,
  extra: Partial<typeof documents.$inferInsert> = {},
): typeof documents.$inferInsert {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  return {
    repoId,
    path,
    title,
    blobSha: `sha-${path}`,
    sizeBytes: 10,
    body: `# ${title}\n\nBody of ${path}.`,
    reserved: name === "index.md" ? "index" : name === "log.md" ? "log" : null,
    ...extra,
  };
}

const BIG_DOCS = 2000;

async function seed(db: Db): Promise<Seed> {
  const handbook = await insertRepo(db, {
    githubId: 101,
    owner: "Acme",
    name: "Handbook",
    visibility: "public",
    description: "The handbook",
    docsPath: "docs",
    readmePath: "README.md",
    readmeMarkdown: "# Handbook\n\nWelcome.",
    readmeSha: "readme-sha",
    codeownersPath: ".github/CODEOWNERS",
    codeownersSha: "co-sha",
    isOkf: true,
    okfVersion: "0.2",
    syncStatus: "ok",
    lastSyncedAt: new Date("2026-01-02T03:04:05Z"),
    treeSha: "tree",
    syncRequestedAt: new Date(),
  });
  const secret = await insertRepo(db, {
    githubId: 102,
    owner: "acme",
    name: "secret",
    visibility: "private",
    docsPath: "documentation",
    readmeMarkdown: "# Secret",
    readmePath: "README.md",
    syncStatus: "error",
    syncError: "GitHub rate limit reached; retry later",
  });
  const empty = await insertRepo(db, {
    githubId: 103,
    owner: "beta",
    name: "empty",
    visibility: "public",
  });
  const big = await insertRepo(db, {
    githubId: 104,
    owner: "zeta",
    name: "big",
    visibility: "public",
    docsPath: "docs",
  });

  await db.insert(documents).values([
    doc(handbook, "docs/index.md", "Overview", {
      description: "Everything about Acme",
      frontmatter: { okf_version: "0.2" },
    }),
    doc(handbook, "docs/guides/index.md", "Guides", { description: "How-tos" }),
    doc(handbook, "docs/guides/setup.md", "Setup", {
      description: "Set things up",
      type: "Guide",
      tags: ["onboarding", "Setup"],
      status: "draft",
      headings: [
        { depth: 1, text: "Setup", slug: "setup" },
        { depth: 2, text: "Install", slug: "install" },
      ],
      frontmatter: { type: "Guide", owner_team: "platform", tags: ["onboarding", "Setup"] },
    }),
    doc(handbook, "docs/guides/advanced/tuning.md", "Tuning", { type: "metric" }),
    doc(handbook, "docs/log.md", "Changelog"),
    doc(handbook, "docs/Upper.MD", "Upper"),
    doc(handbook, "docs/both.md", "Both md"),
    doc(handbook, "docs/both.mdx", "Both mdx"),
    doc(handbook, "docs/odd.md", "Odd JSON"),
    doc(handbook, "docs/100%_real\\'quote.md", "Weird name"),
    doc(secret, "documentation/private.md", "Private plan"),
    doc(secret, "documentation/more.md", "More private"),
  ]);
  // JSONB the sync never writes, to prove reads are defensive.
  await db
    .update(documents)
    .set({
      headings: sql`'[{"depth":2,"text":"Ok","slug":"ok"},{"depth":"x","text":"Bad","slug":"bad"},null,5,{"depth":9,"text":"Deep","slug":"deep"}]'::jsonb`,
      frontmatter: sql`'[1,2,3]'::jsonb`,
    })
    .where(eq(documents.path, "docs/odd.md"));
  const bigDocs = Array.from({ length: BIG_DOCS }, (_, i) =>
    doc(big, `docs/section-${i % 40}/page-${i}.md`, `Page ${i}`, {
      tags: ["t"],
      type: i % 2 === 0 ? "Metric" : null,
    }),
  );
  for (let i = 0; i < bigDocs.length; i += 500) {
    await db.insert(documents).values(bigDocs.slice(i, i + 500));
  }

  await db.insert(codeOwners).values([
    {
      repoId: handbook,
      position: 1,
      pattern: "/docs/",
      owners: [{ handle: "@my-org/docs-team", kind: "team" }],
      sourcePath: ".github/CODEOWNERS",
    },
    {
      repoId: handbook,
      position: 0,
      pattern: "*",
      owners: [{ handle: "@alice", kind: "user" }],
      sourcePath: ".github/CODEOWNERS",
    },
    {
      repoId: handbook,
      position: 2,
      pattern: "*.md",
      owners: sql`'[{"handle":"@bob","kind":"user"},{"handle":5},{"handle":"@x","kind":"robot"},null,{"handle":"a@b.co","kind":"email"}]'::jsonb`,
      sourcePath: ".github/CODEOWNERS",
    },
    {
      repoId: secret,
      position: 0,
      pattern: "*",
      owners: [{ handle: "@carol", kind: "user" }],
      sourcePath: "CODEOWNERS",
    },
  ]);
  const [secretRoot] = await db
    .insert(docComments)
    .values({
      githubRepoId: 102,
      path: "documentation/private.md",
      authorLabel: "carol",
      body: "Private question",
    })
    .returning({ id: docComments.id });
  const [secretReply] = await db
    .insert(docComments)
    .values({
      githubRepoId: 102,
      path: "documentation/private.md",
      parentId: secretRoot?.id,
      authorLabel: "dan",
      body: "Private answer",
    })
    .returning({ id: docComments.id });
  await seedRuns(db);
  return {
    handbook,
    secret,
    empty,
    big,
    secretRoot: secretRoot?.id ?? 0,
    secretReply: secretReply?.id ?? 0,
  };
}

/** A `sync_runs.results` entry with zero counts unless overridden. */
function runEntry(
  githubId: number,
  repo: string,
  extra: Partial<SyncRepoResult> = {},
): SyncRepoResult {
  return {
    repo,
    githubId,
    status: "ok",
    error: null,
    errorKind: null,
    retryable: false,
    retryAfter: null,
    added: 0,
    updated: 0,
    identical: 0,
    removed: 0,
    skipped: 0,
    skippedFiles: [],
    failedFiles: [],
    failedFilesTotal: 0,
    warnings: [],
    warningsTotal: 0,
    replacedRepos: [],
    ...extra,
  };
}

/**
 * Sync runs (task 12.2), oldest first: a full run covering the public handbook (ok), the private
 * secret (error) and a removed repository; then a single-repo run of the private secret (the
 * latest finished run); then a running single-repo run of the secret.
 */
async function seedRuns(db: Db): Promise<void> {
  await db.insert(syncRuns).values([
    {
      trigger: "schedule",
      scope: null,
      status: "partial",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:00:12Z"),
      reposTotal: 2,
      reposSynced: 1,
      reposFailed: 1,
      docsAdded: 99,
      results: [
        runEntry(101, "Acme/Handbook", {
          added: 3,
          updated: 1,
          skipped: 2,
          warningsTotal: 4,
        }),
        runEntry(102, "acme/secret", {
          status: "error",
          error: "GitHub rate limit reached; retry later",
          added: 5,
        }),
        runEntry(999, "gone/repo", { status: "removed", removed: 7 }),
        runEntry(103, "beta/empty", { status: "unchanged" }),
      ],
    },
    {
      trigger: "webhook",
      scope: "acme/secret",
      status: "success",
      startedAt: new Date("2026-01-02T00:00:00Z"),
      finishedAt: new Date("2026-01-02T00:00:01Z"),
      results: [runEntry(102, "acme/secret", { added: 1, warningsTotal: 2 })],
    },
    {
      trigger: "manual",
      scope: "ACME/Secret",
      status: "running",
      startedAt: new Date("2026-01-03T00:00:00Z"),
    },
  ]);
}

/** One way of reaching the private repository through a query, and whether it was seen. */
type FlipCase = {
  label: string;
  run: (db: Db, options: QueryOptions) => Promise<unknown>;
  seen: (result: unknown) => boolean;
};

const nonEmpty = (r: unknown) =>
  Array.isArray(r) ? r.length > 0 : r instanceof Set ? r.size > 0 : false;

/**
 * For every registered query, the calls that reach the private repository `acme/secret`. Keyed
 * by registry name; the test fails when a registered query has no entry here.
 */
function flipCases(s: Seed): Record<keyof typeof QUERY_FUNCTIONS, FlipCase[]> {
  const byId = { id: s.secret };
  const byName = { owner: "ACME", name: "Secret" };
  return {
    listRepos: [
      {
        label: "home grid",
        run: (db, o) => listRepos(db, {}, o),
        seen: (r) => (r as { id: number }[]).some((x) => x.id === s.secret),
      },
    ],
    getRepo: [
      { label: "by name", run: (db, o) => getRepo(db, "acme", "secret", o), seen: (r) => !!r },
    ],
    listCodeOwners: [
      { label: "by id", run: (db, o) => listCodeOwners(db, byId, o), seen: nonEmpty },
      { label: "by name", run: (db, o) => listCodeOwners(db, byName, o), seen: nonEmpty },
    ],
    getDocsTree: [
      { label: "by id", run: (db, o) => getDocsTree(db, byId, o), seen: nonEmpty },
      { label: "by name", run: (db, o) => getDocsTree(db, byName, o), seen: nonEmpty },
    ],
    getDocumentByPath: [
      {
        label: "by id",
        run: (db, o) => getDocumentByPath(db, byId, "documentation/private.md", o),
        seen: (r) => !!r,
      },
      {
        label: "by name",
        run: (db, o) => getDocumentByPath(db, byName, ["documentation/private.md"], o),
        seen: (r) => !!r,
      },
    ],
    getDocPaths: [
      { label: "by id", run: (db, o) => getDocPaths(db, byId, o), seen: nonEmpty },
      { label: "by name", run: (db, o) => getDocPaths(db, byName, o), seen: nonEmpty },
    ],
    getAdjacentDocs: [
      {
        label: "by id",
        run: (db, o) => getAdjacentDocs(db, byId, "documentation/private.md", o),
        seen: (r) => !!r,
      },
      {
        label: "by name",
        run: (db, o) => getAdjacentDocs(db, byName, "documentation/more.md", o),
        seen: (r) => !!r,
      },
    ],
    countDocs: [
      { label: "by id", run: (db, o) => countDocs(db, byId, o), seen: (r) => (r as number) > 0 },
      {
        label: "by name",
        run: (db, o) => countDocs(db, byName, o),
        seen: (r) => (r as number) > 0,
      },
    ],
    findAssetRepo: [
      {
        label: "asset proxy",
        run: (db, o) => findAssetRepo(db, "Acme", "SECRET", o),
        seen: (r) => !!r,
      },
    ],
    searchDocuments: [
      {
        label: "hits",
        run: (db, o) => searchDocuments(db, { q: "private" }, o),
        seen: (r) =>
          (r as { hits: { repo: { id: number } }[] }).hits.some((h) => h.repo.id === s.secret),
      },
      {
        label: "total",
        run: (db, o) => searchDocuments(db, { q: "private" }, o),
        seen: (r) => (r as { total: number }).total > 0,
      },
      {
        label: "repo filter by name",
        run: (db, o) => searchDocuments(db, { q: "body", repo: "ACME/Secret" }, o),
        seen: (r) => (r as { total: number }).total > 0,
      },
    ],
    getRepoFacets: [
      {
        label: "by id",
        run: (db, o) => getRepoFacets(db, byId, {}, o),
        seen: (r) => (r as { total: number }).total > 0,
      },
      {
        label: "by name",
        run: (db, o) => getRepoFacets(db, byName, undefined, o),
        seen: (r) => (r as { total: number }).total > 0,
      },
    ],
    getSyncStatus: [
      {
        label: "repository list",
        run: (db, o) => getSyncStatus(db, {}, o),
        seen: (r) => (r as { repos: { name: string }[] }).repos.some((x) => x.name === "secret"),
      },
      {
        label: "last run scoped to the repository",
        run: (db, o) => getSyncStatus(db, {}, o),
        seen: (r) =>
          (r as { lastRun: { scope: string | null } | null }).lastRun?.scope === "acme/secret",
      },
      {
        label: "run counts",
        run: (db, o) => getSyncStatus(db, {}, o),
        seen: (r) => {
          const run = (
            r as { lastRun: { scope: string | null; counts: { failed: number } } | null }
          ).lastRun;
          // The full run, when the scoped run is hidden: its failure is the secret's.
          return run !== null && (run.scope !== null || run.counts.failed > 0);
        },
      },
      {
        label: "running run",
        run: (db, o) => getSyncStatus(db, {}, o),
        seen: (r) => (r as { running: unknown }).running !== null,
      },
      {
        label: "totals",
        run: (db, o) => getSyncStatus(db, {}, o),
        seen: (r) => (r as { reposByStatus: { error: number } }).reposByStatus.error > 0,
      },
    ],
    getRepoSyncInfo: [
      { label: "by id", run: (db, o) => getRepoSyncInfo(db, byId, o), seen: (r) => r !== null },
      { label: "by name", run: (db, o) => getRepoSyncInfo(db, byName, o), seen: (r) => r !== null },
    ],
    listDocComments: [
      {
        label: "by id",
        run: (db, o) => listDocComments(db, { repo: byId, path: "documentation/private.md" }, o),
        seen: (r) => (r as { threads: unknown[] }).threads.length > 0,
      },
      {
        label: "by name",
        run: (db, o) => listDocComments(db, { repo: byName, path: "documentation/private.md" }, o),
        seen: (r) => (r as { threads: unknown[] }).threads.length > 0,
      },
    ],
    countDocComments: [
      {
        label: "comments",
        run: (db, o) => countDocComments(db, { repo: byId, path: "documentation/private.md" }, o),
        seen: (r) => (r as { comments: number }).comments > 0,
      },
      {
        label: "open threads",
        run: (db, o) => countDocComments(db, { repo: byName, path: "documentation/private.md" }, o),
        seen: (r) => (r as { openThreads: number }).openThreads > 0,
      },
    ],
    getCommentDocument: [
      {
        label: "by name",
        run: (db, o) =>
          getCommentDocument(db, { repo: byName, path: "documentation/private.md" }, o),
        seen: (r) => !!r,
      },
    ],
    getCommentTarget: [
      { label: "root", run: (db, o) => getCommentTarget(db, s.secretRoot, o), seen: (r) => !!r },
      { label: "reply", run: (db, o) => getCommentTarget(db, s.secretReply, o), seen: (r) => !!r },
    ],
    getCommentThread: [
      { label: "root", run: (db, o) => getCommentThread(db, s.secretRoot, o), seen: (r) => !!r },
    ],
    listCommentsForModeration: [
      {
        label: "list",
        run: (db, o) => listCommentsForModeration(db, {}, o),
        seen: (r) =>
          (r as { items: { githubRepoId: number }[] }).items.some((x) => x.githubRepoId === 102),
      },
      {
        label: "repository filter",
        run: (db, o) => listCommentsForModeration(db, { githubRepoId: 102 }, o),
        seen: (r) => (r as { items: unknown[] }).items.length > 0,
      },
    ],
    getCommentStates: [
      {
        label: "by ids",
        run: (db, o) => getCommentStates(db, { ids: [s.secretRoot, s.secretReply] }, o),
        seen: nonEmpty,
      },
      {
        label: "by document",
        run: (db, o) =>
          getCommentStates(db, { githubRepoId: 102, path: "documentation/private.md" }, o),
        seen: nonEmpty,
      },
    ],
    searchFacets: [
      {
        label: "repo counts",
        run: (db, o) => searchFacets(db, { q: "body" }, o),
        seen: (r) => (r as { repos: { id: number }[] }).repos.some((x) => x.id === s.secret),
      },
      {
        label: "total",
        run: (db, o) => searchFacets(db, { q: "private" }, o),
        seen: (r) => (r as { total: number }).total > 0,
      },
      {
        label: "total with repo filter by id",
        run: (db, o) => searchFacets(db, { q: "body", repo: s.secret }, o),
        seen: (r) => (r as { total: number }).total > 0,
      },
    ],
  };
}

describeDb("query layer on a real database", () => {
  let t: TestDatabase;
  let s: Seed;
  /** Every SQL statement sent through `logged`. */
  const statements: string[] = [];
  let logged: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await seed(t.db);
    logged = drizzle(t.pool, {
      schema,
      logger: { logQuery: (query) => void statements.push(query) },
    });
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  describe("listRepos", () => {
    it("lists every repository, public and private, ordered by owner then name", async () => {
      const list = await listRepos(t.db);
      expect(list.map((r) => `${r.owner}/${r.name}`)).toEqual([
        "Acme/Handbook",
        "acme/secret",
        "beta/empty",
        "zeta/big",
      ]);
      expect(list[0]).toEqual({
        id: s.handbook,
        owner: "Acme",
        name: "Handbook",
        description: "The handbook",
        htmlUrl: "https://github.com/Acme/Handbook",
        visibility: "public",
        isAllowed: true,
        starPosition: null,
        isStarred: false,
        isOkf: true,
        okfVersion: "0.2",
        syncStatus: "ok",
        syncError: null,
        lastSyncedAt: new Date("2026-01-02T03:04:05Z"),
        docCount: 10,
      });
      expect(list[1]).toMatchObject({
        visibility: "private",
        syncStatus: "error",
        syncError: "GitHub rate limit reached; retry later",
        docCount: 2,
      });
      expect(list[2]?.docCount).toBe(0);
      expect(list[3]?.docCount).toBe(BIG_DOCS);
    });

    it("returns the star place and derives isStarred; a blocked starred repo stays hidden", async () => {
      const id = await insertRepo(t.db, {
        githubId: 9001,
        owner: "star",
        name: "kept",
        visibility: "public",
        starPosition: 3,
      });
      try {
        const starred = (await listRepos(t.db)).find((r) => r.id === id);
        expect(starred).toMatchObject({ starPosition: 3, isStarred: true });
        await t.db.update(repos).set({ isAllowed: false }).where(eq(repos.id, id));
        expect((await listRepos(t.db)).some((r) => r.id === id)).toBe(false);
        const all = await listRepos(t.db, {}, { visibility: allowAllRepos });
        expect(all.find((r) => r.id === id)).toMatchObject({ starPosition: 3, isStarred: true });
      } finally {
        await t.db.delete(repos).where(eq(repos.id, id));
      }
    });

    it("pages stably and ignores invalid paging values", async () => {
      const all = await listRepos(t.db);
      const pages = [
        ...(await listRepos(t.db, { limit: 3, offset: 0 })),
        ...(await listRepos(t.db, { limit: 3, offset: 3 })),
      ];
      expect(pages.map((r) => r.id)).toEqual(all.map((r) => r.id));
      expect(await listRepos(t.db, { limit: 1, offset: 99 })).toEqual([]);
      for (const limit of [0, -1, Number.NaN, 1.5, 1e9, Infinity]) {
        expect((await listRepos(t.db, { limit })).length).toBe(all.length);
      }
      expect((await listRepos(t.db, { offset: -5 })).length).toBe(all.length);
    });

    it("returns an empty list when nothing is visible (the 'nothing synced' state)", async () => {
      expect(await listRepos(t.db, {}, { visibility: () => sql`false` })).toEqual([]);
    });
  });

  describe("getRepo", () => {
    it("matches owner/name ignoring case and returns the stored spelling and every section", async () => {
      const repo = await getRepo(t.db, "ACME", "handbook");
      expect(repo).toMatchObject({
        id: s.handbook,
        githubId: 101,
        owner: "Acme",
        name: "Handbook",
        defaultBranch: "main",
        docsPath: "docs",
        readme: { path: "README.md", markdown: "# Handbook\n\nWelcome.", sha: "readme-sha" },
        codeownersPath: ".github/CODEOWNERS",
        docCount: 10,
        isOkf: true,
        okfVersion: "0.2",
      });
      expect(repo?.codeOwners).toEqual([
        {
          position: 0,
          pattern: "*",
          owners: [{ handle: "@alice", kind: "user" }],
          sourcePath: ".github/CODEOWNERS",
        },
        {
          position: 1,
          pattern: "/docs/",
          owners: [{ handle: "@my-org/docs-team", kind: "team" }],
          sourcePath: ".github/CODEOWNERS",
        },
        {
          position: 2,
          pattern: "*.md",
          owners: [
            { handle: "@bob", kind: "user" },
            { handle: "a@b.co", kind: "email" },
          ],
          sourcePath: ".github/CODEOWNERS",
        },
      ]);
    });

    it("exposes isOkf and okfVersion for OKF and for plain repositories (task 11.1)", async () => {
      expect(await getRepo(t.db, "acme", "handbook")).toMatchObject({
        isOkf: true,
        okfVersion: "0.2",
      });
      // The seeded repositories that are not OKF: false and no version, in detail and in the list.
      expect(await getRepo(t.db, "acme", "secret")).toMatchObject({
        isOkf: false,
        okfVersion: null,
      });
      const list = await listRepos(t.db);
      expect(list.map((r) => [r.name, r.isOkf, r.okfVersion])).toEqual([
        ["Handbook", true, "0.2"],
        ["secret", false, null],
        ["empty", false, null],
        ["big", false, null],
      ]);
    });

    it("exposes no sync internals", async () => {
      const repo = await getRepo(t.db, "Acme", "Handbook");
      for (const key of [
        "treeSha",
        "syncRequestedAt",
        "selectionFingerprint",
        "headEtag",
        "commitSha",
        "codeownersSha",
      ]) {
        expect(repo).not.toHaveProperty(key);
      }
    });

    it("has empty README and code owner sections when the repository has none", async () => {
      const repo = await getRepo(t.db, "beta", "empty");
      expect(repo).toMatchObject({ readme: null, codeOwners: [], docsPath: null, docCount: 0 });
    });

    it("returns null for an unknown repository", async () => {
      expect(await getRepo(t.db, "acme", "nope")).toBeNull();
      expect(await getRepo(t.db, "nobody", "handbook")).toBeNull();
    });

    it("refuses an ambiguous case-insensitive match and prefers the exact spelling", async () => {
      const a = await insertRepo(t.db, {
        githubId: 201,
        owner: "twin",
        name: "Repo",
        visibility: "public",
      });
      const b = await insertRepo(t.db, {
        githubId: 202,
        owner: "twin",
        name: "repo",
        visibility: "public",
      });
      try {
        expect((await getRepo(t.db, "twin", "Repo"))?.id).toBe(a);
        expect((await getRepo(t.db, "twin", "repo"))?.id).toBe(b);
        expect(await getRepo(t.db, "TWIN", "REPO")).toBeNull();
        expect(await getDocsTree(t.db, { owner: "TWIN", name: "REPO" })).toEqual([]);
      } finally {
        await t.db.delete(repos).where(eq(repos.owner, "twin"));
      }
    });

    it("clips an over-long stored sync error", async () => {
      const id = await insertRepo(t.db, {
        githubId: 301,
        owner: "long",
        name: "error",
        visibility: "public",
        syncStatus: "error",
        syncError: "x".repeat(5000),
      });
      try {
        const repo = await getRepo(t.db, "long", "error");
        expect(repo?.syncError?.length).toBe(500);
      } finally {
        await t.db.delete(repos).where(eq(repos.id, id));
      }
    });
  });

  describe("documents", () => {
    it("returns tree rows that build the ordered docs tree", async () => {
      const repo = await getRepo(t.db, "acme", "handbook");
      const rows = await getDocsTree(t.db, { id: s.handbook });
      expect(rows.map((r) => r.path)).toEqual([...rows.map((r) => r.path)].sort());
      expect(rows.find((r) => r.path === "docs/guides/setup.md")).toEqual({
        path: "docs/guides/setup.md",
        title: "Setup",
        description: "Set things up",
        type: "Guide",
        tags: ["onboarding", "Setup"],
        status: "draft",
        reserved: null,
      });
      const tree = buildDocsTree(rows, repo?.docsPath);
      expect(tree.index?.title).toBe("Overview");
      expect(tree.index?.description).toBe("Everything about Acme");
      expect(flattenDocsTree(tree).map((d) => d.title)).toEqual([
        "Overview",
        "Both md",
        "Both mdx",
        "Odd JSON",
        "Upper",
        "Weird name",
        "Changelog",
        "Guides",
        "Setup",
        "Tuning",
      ]);
      expect(await getDocsTree(t.db, { owner: "acme", name: "HANDBOOK" })).toEqual(rows);
      expect(await getDocsTree(t.db, { id: s.empty })).toEqual([]);
    });

    it("finds a document through docPathCandidates, with every stored field", async () => {
      const repo = await getRepo(t.db, "acme", "handbook");
      const found = await getDocumentByPath(
        t.db,
        { id: s.handbook },
        docPathCandidates(repo?.docsPath, ["guides", "setup"]),
      );
      expect(found).toMatchObject({
        repoId: s.handbook,
        path: "docs/guides/setup.md",
        blobSha: "sha-docs/guides/setup.md",
        sizeBytes: 10,
        title: "Setup",
        description: "Set things up",
        type: "Guide",
        tags: ["onboarding", "Setup"],
        status: "draft",
        headings: [
          { depth: 1, text: "Setup", slug: "setup" },
          { depth: 2, text: "Install", slug: "install" },
        ],
        frontmatter: { type: "Guide", owner_team: "platform", tags: ["onboarding", "Setup"] },
        body: "# Setup\n\nBody of docs/guides/setup.md.",
        reserved: null,
      });
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.updatedAt).toBeInstanceOf(Date);
    });

    it("resolves index pages, .md before .mdx, and an upper-case extension", async () => {
      const ref = { id: s.handbook };
      const at = async (...segments: string[]) =>
        (await getDocumentByPath(t.db, ref, docPathCandidates("docs", segments)))?.path ?? null;
      expect(await at("guides", "index")).toBe("docs/guides/index.md");
      expect(await at("both")).toBe("docs/both.md");
      expect(await at("Upper")).toBe("docs/Upper.MD");
      expect(await at("upper")).toBeNull();
      expect(await at("guides")).toBeNull();
      expect(await at("nope")).toBeNull();
      expect(await at("100%_real\\'quote")).toBeNull(); // backslash segments are not routes
      expect((await getDocumentByPath(t.db, ref, "docs/100%_real\\'quote.md"))?.title).toBe(
        "Weird name",
      );
      expect(await getDocumentByPath(t.db, ref, [])).toBeNull();
    });

    it("reads malformed JSONB defensively", async () => {
      const found = await getDocumentByPath(t.db, { id: s.handbook }, "docs/odd.md");
      expect(found?.headings).toEqual([{ depth: 2, text: "Ok", slug: "ok" }]);
      expect(found?.frontmatter).toEqual({});
    });

    it("returns the path set for link rewriting", async () => {
      const paths = await getDocPaths(t.db, { owner: "Acme", name: "Handbook" });
      expect(paths).toBeInstanceOf(Set);
      expect(paths.size).toBe(10);
      expect(paths.has("docs/guides/advanced/tuning.md")).toBe(true);
      expect((await getDocPaths(t.db, { id: s.empty })).size).toBe(0);
    });

    it("finds previous and next documents in tree order", async () => {
      const ref = { id: s.handbook };
      const adj = await getAdjacentDocs(t.db, ref, "docs/guides/setup.md");
      expect(adj?.previous?.path).toBe("docs/guides/index.md");
      expect(adj?.next?.path).toBe("docs/guides/advanced/tuning.md");
      expect((await getAdjacentDocs(t.db, ref, "docs/index.md"))?.previous).toBeNull();
      expect((await getAdjacentDocs(t.db, ref, "docs/guides/advanced/tuning.md"))?.next).toBeNull();
      expect(await getAdjacentDocs(t.db, ref, "docs/nope.md")).toBeNull();
      expect(await getAdjacentDocs(t.db, { id: s.empty }, "docs/index.md")).toBeNull();
    });

    it("counts documents", async () => {
      expect(await countDocs(t.db, { id: s.handbook })).toBe(10);
      expect(await countDocs(t.db, { owner: "zeta", name: "big" })).toBe(BIG_DOCS);
      expect(await countDocs(t.db, { id: s.empty })).toBe(0);
    });

    it("returns nothing for an unknown repository", async () => {
      const unknown = { owner: "acme", name: "nope" };
      expect(await getDocsTree(t.db, unknown)).toEqual([]);
      expect(await getDocsTree(t.db, { id: 999_999 })).toEqual([]);
      expect(await getDocumentByPath(t.db, unknown, "docs/index.md")).toBeNull();
      expect((await getDocPaths(t.db, unknown)).size).toBe(0);
      expect(await getAdjacentDocs(t.db, unknown, "docs/index.md")).toBeNull();
      expect(await countDocs(t.db, unknown)).toBe(0);
      expect(await listCodeOwners(t.db, unknown)).toEqual([]);
    });
  });

  describe("sync status (task 12.2)", () => {
    it("reports the latest visible run, the running run and every repository's state", async () => {
      const status = await getSyncStatus(t.db);
      expect(status.lastRun).toEqual({
        trigger: "webhook",
        scope: "acme/secret",
        status: "success",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        finishedAt: new Date("2026-01-02T00:00:01Z"),
        durationMs: 1000,
        error: null,
        counts: {
          repos: 1,
          ok: 1,
          failed: 0,
          skipped: 0,
          docsAdded: 1,
          docsUpdated: 0,
          docsRemoved: 0,
          docsSkipped: 0,
          warnings: 2,
        },
      });
      expect(status.running).toEqual({
        trigger: "manual",
        scope: "ACME/Secret",
        startedAt: new Date("2026-01-03T00:00:00Z"),
      });
      expect(status.repos.map((r) => `${r.owner}/${r.name}`)).toEqual([
        "Acme/Handbook",
        "acme/secret",
        "beta/empty",
        "zeta/big",
      ]);
      expect(status.repos[1]).toEqual({
        owner: "acme",
        name: "secret",
        visibility: "private",
        syncStatus: "error",
        syncError: "GitHub rate limit reached; retry later",
        lastSyncedAt: null,
        warnings: [],
        skippedFiles: 0,
      });
      expect(status.reposTotal).toBe(4);
      expect(status.reposByStatus).toEqual({ ok: 1, error: 1, pending: 2 });
      expect(status.reposWithWarnings).toBe(0);
      expect(status.truncated).toBe(false);
      const text = JSON.stringify(status);
      for (const internal of ["treeSha", "tree", "githubId", "syncRequestedAt", "selection"]) {
        expect(text).not.toContain(internal);
      }
    });

    it("hides a hidden repository's run and counts only visible repositories", async () => {
      const status = await getSyncStatus(t.db, {}, { visibility: publicReposOnly });
      expect(status.repos.map((r) => r.name)).toEqual(["Handbook", "empty", "big"]);
      expect(status.running).toBeNull();
      // The secret's own run is skipped: the full run is the latest visible one. Its counts
      // leave out the secret (error) and the removed repository (no visible row).
      expect(status.lastRun).toMatchObject({
        trigger: "schedule",
        scope: null,
        status: "partial",
        counts: {
          repos: 2,
          ok: 2,
          failed: 0,
          skipped: 0,
          docsAdded: 3,
          docsUpdated: 1,
          docsRemoved: 0,
          docsSkipped: 2,
          warnings: 4,
        },
      });
      expect(JSON.stringify(status)).not.toMatch(/secret|gone\/repo|rate limit/i);
      expect(status.reposByStatus).toEqual({ ok: 1, error: 0, pending: 2 });
    });

    it("caps the repository list and flags it", async () => {
      const status = await getSyncStatus(t.db, { limit: 2 });
      expect(status.repos).toHaveLength(2);
      expect(status.truncated).toBe(true);
      expect(status.reposTotal).toBe(4);
      for (const limit of [0, -1, 1.5, Number.NaN, 10_000]) {
        expect((await getSyncStatus(t.db, { limit })).repos).toHaveLength(4);
      }
    });

    it("parses stored sync warnings defensively", async () => {
      await t.db
        .update(repos)
        .set({
          syncWarnings: sql`'[{"code":"docs_capped","message":"Only the first 2 of 5","count":3,"paths":["docs/c.md","docs/d.md",7]},{"code":5},null,"x"]'::jsonb`,
        })
        .where(eq(repos.id, s.big));
      try {
        const status = await getSyncStatus(t.db);
        const big = status.repos.find((r) => r.name === "big");
        expect(big?.warnings).toEqual([
          { code: "docs_capped", message: "Only the first 2 of 5", count: 3 },
        ]);
        expect(big?.skippedFiles).toBe(3);
        expect(status.reposWithWarnings).toBe(1);
        const detail = await getRepo(t.db, "zeta", "big");
        expect(detail?.syncWarnings).toEqual([
          {
            code: "docs_capped",
            message: "Only the first 2 of 5",
            count: 3,
            paths: ["docs/c.md", "docs/d.md"],
          },
        ]);
      } finally {
        await t.db.update(repos).set({ syncWarnings: [] }).where(eq(repos.id, s.big));
      }
    });

    it("finds a repository's latest run and its own outcome", async () => {
      expect(await getRepoSyncInfo(t.db, { id: s.secret })).toEqual({
        lastRun: {
          trigger: "webhook",
          fullRun: false,
          startedAt: new Date("2026-01-02T00:00:00Z"),
          finishedAt: new Date("2026-01-02T00:00:01Z"),
          outcome: "ok",
          error: null,
          added: 1,
          updated: 0,
          removed: 0,
          skipped: 0,
          warnings: 2,
        },
      });
      expect(await getRepoSyncInfo(t.db, { owner: "acme", name: "HANDBOOK" })).toEqual({
        lastRun: {
          trigger: "schedule",
          fullRun: true,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          finishedAt: new Date("2026-01-01T00:00:12Z"),
          outcome: "ok",
          error: null,
          added: 3,
          updated: 1,
          removed: 0,
          skipped: 2,
          warnings: 4,
        },
      });
      expect(await getRepoSyncInfo(t.db, { id: s.big })).toEqual({ lastRun: null });
      expect(await getRepoSyncInfo(t.db, { owner: "acme", name: "nope" })).toBeNull();
      expect(
        await getRepoSyncInfo(t.db, { id: s.secret }, { visibility: publicReposOnly }),
      ).toBeNull();
    });
  });

  describe("single enforcement point", () => {
    const hideAll: RepoVisibilityFilter = () => sql`false`;

    it("has a flip case for every registered query", () => {
      expect(Object.keys(flipCases(s)).sort()).toEqual(Object.keys(QUERY_FUNCTIONS).sort());
    });

    it("shows the private repository everywhere with the default (allow-all) filter", async () => {
      for (const [name, cases] of Object.entries(flipCases(s))) {
        for (const c of cases) {
          expect(c.seen(await c.run(t.db, {})), `${name} ${c.label}`).toBe(true);
          expect(c.seen(await c.run(t.db, { visibility: allowAllRepos })), name).toBe(true);
        }
      }
    });

    it("hides the private repository from every query when the filter hides private repos", async () => {
      for (const [name, cases] of Object.entries(flipCases(s))) {
        for (const c of cases) {
          const options = { visibility: publicReposOnly };
          expect(c.seen(await c.run(t.db, options)), `${name} ${c.label}`).toBe(false);
        }
      }
      // Public repositories stay visible.
      const list = await listRepos(t.db, {}, { visibility: publicReposOnly });
      expect(list.map((r) => r.name)).toEqual(["Handbook", "empty", "big"]);
      const handbook = await getRepo(t.db, "acme", "handbook", { visibility: publicReposOnly });
      expect(handbook?.codeOwners.length).toBe(3);
      expect(
        await getDocumentByPath(t.db, { id: s.handbook }, "docs/index.md", {
          visibility: publicReposOnly,
        }),
      ).not.toBeNull();
    });

    it("honours a custom filter (one repository only) and a hide-all filter", async () => {
      const onlyHandbook: RepoVisibilityFilter = (table) => eq(table.id, s.handbook);
      for (const [name, cases] of Object.entries(flipCases(s))) {
        for (const c of cases) {
          expect(c.seen(await c.run(t.db, { visibility: onlyHandbook })), name).toBe(false);
          expect(c.seen(await c.run(t.db, { visibility: hideAll })), name).toBe(false);
        }
      }
      const list = await listRepos(t.db, {}, { visibility: onlyHandbook });
      expect(list.map((r) => r.id)).toEqual([s.handbook]);
      expect(await countDocs(t.db, { id: s.handbook }, { visibility: hideAll })).toBe(0);
      expect(await getRepo(t.db, "acme", "handbook", { visibility: hideAll })).toBeNull();
    });

    it("reads search_vector only in search and always joins repos for documents and code owners", async () => {
      let total = 0;
      for (const [name, cases] of Object.entries(flipCases(s))) {
        statements.length = 0;
        for (const c of cases) {
          const result = await c.run(logged, {});
          expect(JSON.stringify(result ?? null)).not.toMatch(/searchVector|search_vector/);
        }
        total += statements.length;
        const readsVector = SEARCH_VECTOR_READERS.has(name as keyof typeof QUERY_FUNCTIONS);
        for (const statement of statements) {
          if (!readsVector) expect(statement, name).not.toContain("search_vector");
          if (/"documents"|"code_owners"/.test(statement)) {
            expect(statement, name).toContain('"repos"');
          }
        }
      }
      expect(total).toBeGreaterThan(10);
      expect([...SEARCH_VECTOR_READERS].sort()).toEqual(["searchDocuments", "searchFacets"]);
    });
  });

  describe("hostile input", () => {
    const inputs = [
      "",
      "'",
      '"',
      "%",
      "_",
      "%_%",
      "\\",
      "\\'",
      "' or '1'='1",
      "x'); drop table repos; --",
      "日本語",
      "\uD800",
      "🦄",
      "a\u0000b",
      "\u0000",
      "x".repeat(100_000),
      "../..",
      "docs/../docs/index.md",
      "Acme%",
      "Ha_dbook",
    ];

    it("never throws and finds nothing", async () => {
      const ref = { id: s.handbook };
      for (const bad of inputs) {
        const label = JSON.stringify(bad.slice(0, 40));
        await expect(getRepo(t.db, bad, bad), label).resolves.toBeNull();
        await expect(getRepo(t.db, "acme", bad), label).resolves.toBeNull();
        await expect(findAssetRepo(t.db, bad, "handbook"), label).resolves.toBeNull();
        const named = { owner: bad, name: "handbook" };
        await expect(getDocsTree(t.db, named), label).resolves.toEqual([]);
        await expect(listCodeOwners(t.db, named), label).resolves.toEqual([]);
        await expect(countDocs(t.db, named), label).resolves.toBe(0);
        expect((await getDocPaths(t.db, named)).size, label).toBe(0);
        await expect(getDocumentByPath(t.db, ref, bad), label).resolves.toBeNull();
        await expect(getDocumentByPath(t.db, ref, [bad, bad]), label).resolves.toBeNull();
        await expect(
          getDocumentByPath(t.db, ref, docPathCandidates("docs", [bad])),
          label,
        ).resolves.toBeNull();
        await expect(getAdjacentDocs(t.db, ref, bad), label).resolves.toBeNull();
      }
    });

    it("treats odd ids as unknown", async () => {
      for (const id of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31, 2 ** 53]) {
        await expect(getDocsTree(t.db, { id })).resolves.toEqual([]);
        await expect(getDocumentByPath(t.db, { id }, "docs/index.md")).resolves.toBeNull();
        await expect(countDocs(t.db, { id })).resolves.toBe(0);
        await expect(listCodeOwners(t.db, { id })).resolves.toEqual([]);
      }
    });

    it("still finds a real document when bad candidates come first", async () => {
      const found = await getDocumentByPath(t.db, { id: s.handbook }, [
        "a\u0000b",
        "x".repeat(10_000),
        "docs/index.md",
      ]);
      expect(found?.path).toBe("docs/index.md");
    });
  });

  describe("performance with a 2000-document repository", () => {
    it("loads the tree and the path set quickly", async () => {
      const ref = { id: s.big };
      // Warm up the connection and plan cache.
      await getDocsTree(t.db, ref);
      await getDocPaths(t.db, ref);
      const timings: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const rows = await getDocsTree(t.db, ref);
        const tree = buildDocsTree(rows, "docs");
        const paths = await getDocPaths(t.db, ref);
        timings.push(performance.now() - start);
        expect(rows.length).toBe(BIG_DOCS);
        expect(flattenDocsTree(tree).length).toBe(BIG_DOCS);
        expect(paths.size).toBe(BIG_DOCS);
      }
      timings.sort((a, b) => a - b);
      expect(timings[1]).toBeLessThan(200);
    });
  });
});
