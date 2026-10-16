import { asc, eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { RepoHeader } from "../../components/repo-header";
import { configSchema, type AppConfigInput } from "../config/schema";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { getSyncStatus } from "../queries";
import { loadRepoPage } from "../repo-page";
import { createSyncContext, syncAll, syncLimits, type SyncContext } from "./engine";
import { FakeGitHub, type FakeRepoInit } from "./fake-github";

/**
 * Task 12.3: per-repository document-count and file-size caps, end to end through the engine
 * (fake GitHub, real database): a repo over the caps is capped and warned, documents stored
 * earlier past the cap are removed, the warning reaches `repos.sync_warnings`, the repository
 * header and the status read, and it clears once the repo is back under the caps.
 */

const OWNER = "acme";
const BIG_ID = 501;
const NOW = new Date("2026-10-10T12:00:00Z");

function doc(i: number): [string, string] {
  return [`docs/page-${String(i).padStart(2, "0")}.md`, `# Page ${i}\n\nBody ${i}.\n`];
}

function bigRepo(count: number, extra: Record<string, string> = {}): FakeRepoInit {
  return {
    id: BIG_ID,
    name: "big",
    visibility: "public",
    files: {
      "README.md": "# Big\n",
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => doc(i))),
      ...extra,
    },
  };
}

describeDb("per-repository caps through the sync engine", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    h = createDb(testDb.url.reveal(), { max: 10 });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await h.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
  });

  function ctxFor(fake: FakeGitHub, config: AppConfigInput): SyncContext {
    const github = createGitHubClient({
      getToken: fake.getToken,
      fetch: fake.fetch,
      sleep: async () => undefined,
      maxWaitMs: 1_000,
    });
    return createSyncContext({
      db: h.db,
      pool: h.pool,
      github,
      config: configSchema.parse(config),
    });
  }

  async function storedPaths(): Promise<string[]> {
    const rows = await h.db
      .select({ path: documents.path })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(eq(repos.githubId, BIG_ID))
      .orderBy(asc(documents.path));
    return rows.map((r) => r.path);
  }

  async function row() {
    const [found] = await h.db
      .select({
        syncStatus: repos.syncStatus,
        syncError: repos.syncError,
        syncWarnings: repos.syncWarnings,
        treeSha: repos.treeSha,
      })
      .from(repos)
      .where(eq(repos.githubId, BIG_ID));
    return found;
  }

  it("reads the caps from config, with code defaults", () => {
    const fake = new FakeGitHub({ owner: OWNER, repos: [] });
    expect(syncLimits(ctxFor(fake, {}).config)).toEqual({
      maxFiles: 2000,
      maxFileBytes: 262144,
      maxSpecBytes: 2097152,
    });
    expect(
      syncLimits(ctxFor(fake, { limits: { maxDocsPerRepo: 3, maxFileBytes: 2048 } }).config),
    ).toEqual({ maxFiles: 3, maxFileBytes: 2048, maxSpecBytes: 2097152 });
  });

  it("caps a repo over the document limit, removes earlier extra docs, warns, and clears the warning", async () => {
    const fake = new FakeGitHub({ owner: OWNER, repos: [bigRepo(5)] });

    // Under a generous cap every document is stored.
    let result = await syncAll(ctxFor(fake, { limits: { maxDocsPerRepo: 10 } }), {
      trigger: "manual",
    });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(await storedPaths()).toHaveLength(5);
    expect((await row())?.syncWarnings).toEqual([]);

    // Lowering the cap re-plans (fingerprint) and keeps the first 3 in path order.
    result = await syncAll(ctxFor(fake, { limits: { maxDocsPerRepo: 3 } }), { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(await storedPaths()).toEqual(["docs/page-00.md", "docs/page-01.md", "docs/page-02.md"]);
    const capped = await row();
    expect(capped?.syncStatus).toBe("ok");
    expect(capped?.syncError).toBeNull();
    expect(capped?.treeSha).not.toBeNull();
    expect(capped?.syncWarnings).toEqual([
      {
        code: "docs_capped",
        message:
          "Only the first 3 of 5 documentation files were synced (limit 3 per repository); 2 files left out.",
        count: 2,
        paths: ["docs/page-03.md", "docs/page-04.md"],
      },
    ]);

    // The run records it too: removed documents, skipped files and the warning.
    const [, run] = await h.db.select().from(syncRuns).orderBy(asc(syncRuns.id));
    const entry = run?.results[0];
    expect(entry).toMatchObject({ status: "ok", removed: 2, skipped: 2 });
    expect(entry?.skippedFiles).toEqual([
      { path: "docs/page-03.md", reason: "over_limit" },
      { path: "docs/page-04.md", reason: "over_limit" },
    ]);
    expect(entry?.warnings).toContainEqual({
      path: null,
      message: "document limit reached: 5 docs files found, only the first 3 synced",
    });

    // An unchanged tree short-circuits and keeps the warning.
    await syncAll(ctxFor(fake, { limits: { maxDocsPerRepo: 3 } }), { trigger: "manual" });
    expect((await row())?.syncWarnings).toHaveLength(1);

    // The portal shows it: header (page-level data) and the status read.
    const page = await loadRepoPage(OWNER, "big", { db: () => h.db, now: () => NOW });
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(page.repo.docCount).toBe(3);
    expect(page.lastRun).toMatchObject({ outcome: "unchanged", trigger: "manual" });
    const html = renderToStaticMarkup(
      <RepoHeader repo={page.repo} lastRun={page.lastRun} now={page.loadedAt} />,
    );
    expect(html).toContain('data-testid="repo-sync-warnings"');
    expect(html).toContain("Some files were not synced");
    expect(html).toContain("Only the first 3 of 5 documentation files were synced");
    expect(html).toContain("docs/page-04.md");
    expect(html).toContain("Synced with warnings");
    const status = await getSyncStatus(h.db);
    expect(status.repos[0]).toMatchObject({
      name: "big",
      skippedFiles: 2,
      warnings: [{ code: "docs_capped", count: 2 }],
    });
    expect(status.reposWithWarnings).toBe(1);

    // Back under the cap upstream: the warning clears and nothing is left out.
    fake.deleteFile(BIG_ID, "docs/page-04.md");
    fake.deleteFile(BIG_ID, "docs/page-03.md");
    await syncAll(ctxFor(fake, { limits: { maxDocsPerRepo: 3 } }), { trigger: "manual" });
    expect((await row())?.syncWarnings).toEqual([]);
    expect(await storedPaths()).toHaveLength(3);
    const after = await loadRepoPage(OWNER, "big", { db: () => h.db, now: () => NOW });
    if (after.status !== "ok") throw new Error("expected the page");
    expect(
      renderToStaticMarkup(<RepoHeader repo={after.repo} lastRun={after.lastRun} now={NOW} />),
    ).not.toContain("repo-sync-warnings");
  });

  it("skips an oversized file with a warning and syncs the rest", async () => {
    const big = `# Big\n\n${"x".repeat(3000)}\n`;
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [bigRepo(2, { "docs/huge.md": big })],
    });
    const result = await syncAll(ctxFor(fake, { limits: { maxFileBytes: 2048 } }), {
      trigger: "manual",
    });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(await storedPaths()).toEqual(["docs/page-00.md", "docs/page-01.md"]);
    const stored = await row();
    expect(stored?.syncStatus).toBe("ok");
    expect(stored?.syncWarnings).toEqual([
      {
        code: "too_large",
        message: "1 file larger than 2 KB was not synced.",
        count: 1,
        paths: ["docs/huge.md"],
      },
    ]);
    const [run] = await h.db.select().from(syncRuns);
    expect(run?.results[0]?.skippedFiles).toEqual([{ path: "docs/huge.md", reason: "too_large" }]);

    // Raising the cap again (config change) re-plans and syncs it.
    await syncAll(ctxFor(fake, { limits: { maxFileBytes: 4096 } }), { trigger: "manual" });
    expect(await storedPaths()).toContain("docs/huge.md");
    expect((await row())?.syncWarnings).toEqual([]);
  });

  it("keeps the stored warnings when a later sync fails", async () => {
    const fake = new FakeGitHub({ owner: OWNER, repos: [bigRepo(3)] });
    await syncAll(ctxFor(fake, { limits: { maxDocsPerRepo: 2 } }), { trigger: "manual" });
    expect((await row())?.syncWarnings).toHaveLength(1);
    fake.setFile(BIG_ID, "docs/page-00.md", "# Changed\n");
    fake.fail({ path: /\/branches\//, status: 500 });
    await syncAll(ctxFor(fake, { limits: { maxDocsPerRepo: 2 } }), { trigger: "manual" });
    const failed = await row();
    expect(failed?.syncStatus).toBe("error");
    expect(failed?.syncWarnings).toHaveLength(1);
    expect(await storedPaths()).toHaveLength(2);
  });
});
