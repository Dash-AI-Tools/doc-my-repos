import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { configSchema } from "../config/schema";
import { withRepoSyncLock } from "../db/advisory-lock";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { discoverRepositories, type DiscoveredRepo } from "./discovery";
import { createSyncContext, syncAll, syncRepo, syncRepoLocked, type SyncContext } from "./engine";
import { FakeGitHub, type FakeRepoInit } from "./fake-github";
import { PersistError, persistRepoSync, type PersistPlan, type PersistRepo } from "./persist";
import { describeSyncError } from "./runs";

/**
 * Hardening of task 5.6 (epic 5 review): a repo synced under a name that an OLD stored row still
 * holds (rename A -> B plus a new repo A) deletes that row. When the old repo is mid-sync with a
 * content plan diffed against its stored documents, deleting its row under it would make its sync
 * write only the changed documents into a fresh row and mark it complete. Two guards:
 *
 * - the stale row is deleted only under ITS repo lock (try mode); busy -> `name_conflict_busy`;
 * - a content plan carries the row id it was diffed against (`storedRepoId`); landing in another
 *   row is `stale_plan`, and the engine re-plans from scratch.
 */

const OLD_ID = 11;
const NEW_ID = 12;

function oldRepo(): FakeRepoInit {
  return {
    id: OLD_ID,
    name: "alpha",
    files: {
      "docs/a.md": "# A\n\nfirst\n",
      "docs/b.md": "# B\n",
      "docs/c.md": "# C\n",
    },
  };
}

function newRepo(): FakeRepoInit {
  return { id: NEW_ID, name: "alpha", files: { "docs/y.md": "# Y\n" } };
}

/** A promise with its resolver, for pausing a sync at a known point. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describeDb("same-name row replacement during concurrent syncs", () => {
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

  function ctxFor(fake: FakeGitHub): SyncContext {
    const github = createGitHubClient({
      getToken: fake.getToken,
      fetch: fake.fetch,
      sleep: async () => undefined,
      maxWaitMs: 1_000,
    });
    return createSyncContext({ db: h.db, pool: h.pool, github, config: configSchema.parse({}) });
  }

  async function row(githubId: number) {
    const [r] = await h.db
      .select({
        id: repos.id,
        name: repos.name,
        treeSha: repos.treeSha,
        syncStatus: repos.syncStatus,
      })
      .from(repos)
      .where(eq(repos.githubId, githubId));
    return r;
  }

  async function paths(githubId: number): Promise<string[]> {
    const rows = await h.db
      .select({ path: documents.path })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(eq(repos.githubId, githubId))
      .orderBy(asc(documents.path));
    return rows.map((r) => r.path);
  }

  /** Stores the old repo, then renames it upstream (with one changed doc) and adds a new "alpha". */
  async function renamedAndRecreated(): Promise<{
    fake: FakeGitHub;
    ctx: SyncContext;
    renamed: DiscoveredRepo;
    recreated: DiscoveredRepo;
  }> {
    const fake = new FakeGitHub({ repos: [oldRepo()] });
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    expect(await paths(OLD_ID)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);

    fake.updateRepo(OLD_ID, { name: "beta" });
    fake.setFile(OLD_ID, "docs/a.md", "# A\n\nchanged\n");
    fake.addRepo(newRepo());
    const discovery = await discoverRepositories(ctx.github, ctx.config);
    if (!discovery.complete) throw new Error("listing failed");
    const renamed = discovery.repos.find((r) => r.githubId === OLD_ID) as DiscoveredRepo;
    const recreated = discovery.repos.find((r) => r.githubId === NEW_ID) as DiscoveredRepo;
    return { fake, ctx, renamed, recreated };
  }

  it("the new repo does not delete the old row while the old repo is mid-sync", async () => {
    const { fake, ctx, renamed, recreated } = await renamedAndRecreated();

    // Pause the old repo's sync at its (only) blob fetch: its plan is diffed against the stored
    // documents (only docs/a.md changed), and it holds its repo lock.
    const reached = gate();
    const release = gate();
    fake.onRequest = async (request) => {
      if (/^\/repos\/acme\/beta\/git\/blobs\//.test(request.path)) {
        reached.open();
        await release.opened;
      }
    };
    const oldSync = syncRepoLocked(ctx, renamed);
    await reached.opened;

    // The new repo cannot replace the row the old one is syncing into: retryable failure, nothing
    // written, the old row and its documents untouched.
    const error = await syncRepoLocked(ctx, recreated).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PersistError);
    expect((error as PersistError).kind).toBe("name_conflict_busy");
    expect(describeSyncError(error)).toMatchObject({
      kind: "name_conflict_busy",
      retryable: true,
      fatal: false,
    });
    expect(await row(NEW_ID)).toBeUndefined();
    expect(await row(OLD_ID)).toMatchObject({ name: "alpha" });
    expect(await paths(OLD_ID)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);

    // The old sync finishes into its own row: renamed, every document kept, complete.
    release.open();
    const done = await oldSync;
    expect(done.acquired && done.value.persist).toMatchObject({ complete: true, updated: 1 });
    expect(await row(OLD_ID)).toMatchObject({ name: "beta", syncStatus: "ok" });
    expect((await row(OLD_ID))?.treeSha).not.toBeNull();
    expect(await paths(OLD_ID)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);

    // Retried later: no conflict any more.
    fake.onRequest = null;
    const retried = await syncRepoLocked(ctx, recreated);
    expect(retried.acquired && retried.value.persist.replacedRepos).toEqual([]);
    expect(await paths(NEW_ID)).toEqual(["docs/y.md"]);
  });

  it("when the new repo wins the race, the old repo re-plans into a fresh row with every document", async () => {
    const { fake, ctx, renamed, recreated } = await renamedAndRecreated();

    // The new repo first: the old repo is idle, so its lock is free and its row is replaced.
    const first = await syncRepoLocked(ctx, recreated);
    expect(first.acquired && first.value.persist.replacedRepos).toEqual([
      { githubId: OLD_ID, owner: "acme", name: "alpha" },
    ]);
    expect(await row(OLD_ID)).toBeUndefined();

    fake.clearRequests();
    const second = await syncRepoLocked(ctx, renamed);
    expect(second.acquired && second.value.persist).toMatchObject({ complete: true, added: 3 });
    expect(await paths(OLD_ID)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
  });

  it("a row deleted under a running content plan makes it re-plan instead of dropping documents", async () => {
    const { fake, ctx, renamed } = await renamedAndRecreated();

    // An unguarded writer (the old code path, or any future one) deletes the old row while the
    // old repo's plan, diffed against that row's documents, is in flight.
    let deleted = false;
    fake.onRequest = async (request) => {
      if (!deleted && /^\/repos\/acme\/beta\/git\/blobs\//.test(request.path)) {
        deleted = true;
        await h.db.delete(repos).where(eq(repos.githubId, OLD_ID));
      }
    };
    const result = await withRepoSyncLock(h.pool, { githubId: OLD_ID }, ({ signal }) =>
      syncRepo(ctx, renamed, { signal }),
    );
    expect(deleted).toBe(true);
    // Without the guard the fresh row would hold only docs/a.md, marked complete.
    expect(result.acquired && result.value.persist).toMatchObject({ complete: true, added: 3 });
    expect(await paths(OLD_ID)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
    expect(await row(OLD_ID)).toMatchObject({ name: "beta", syncStatus: "ok" });
  });
});

// ---------------------------------------------------------------------------------------------
// persistRepoSync directly

const sha = (n: number) => String(n).padStart(40, "0");

function meta(githubId: number, name: string): PersistRepo {
  return {
    githubId,
    owner: "acme",
    name,
    description: null,
    defaultBranch: "main",
    archived: false,
    visibility: "public",
    htmlUrl: `https://github.com/acme/${name}`,
  };
}

function plan(text: string, storedRepoId?: number | null): PersistPlan {
  return {
    kind: "content",
    treeSha: sha(1),
    commitSha: sha(2),
    headEtag: null,
    selectionFingerprint: "v1:fp",
    docsFolder: "docs",
    fetched: [{ path: "docs/a.md", blobSha: sha(3), size: text.length, text }],
    removed: [],
    failed: [],
    readme: { state: "absent" },
    codeowners: { state: "absent" },
    ...(storedRepoId === undefined ? {} : { storedRepoId }),
  };
}

describeDb("persistRepoSync name-conflict and stored-row guards", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
  });

  async function ids(): Promise<number[]> {
    const rows = await t.db.select({ g: repos.githubId }).from(repos).orderBy(asc(repos.githubId));
    return rows.map((r) => r.g);
  }

  it("with a pool, a busy conflicting repo fails the call and writes nothing", async () => {
    await persistRepoSync(t.db, { repo: meta(1, "Alpha"), plan: plan("# a\n") });
    const held = await withRepoSyncLock(t.pool, { githubId: 1 }, () =>
      persistRepoSync(t.db, { repo: meta(2, "alpha"), plan: plan("# b\n") }, { pool: t.pool }),
    ).catch((e: unknown) => ({ error: e }));
    expect("error" in held && held.error).toBeInstanceOf(PersistError);
    expect("error" in held && (held.error as PersistError).kind).toBe("name_conflict_busy");
    expect(await ids()).toEqual([1]);
  });

  it("with a pool and a free lock, the conflicting row is replaced", async () => {
    await persistRepoSync(t.db, { repo: meta(1, "alpha"), plan: plan("# a\n") });
    const result = await persistRepoSync(
      t.db,
      { repo: meta(2, "ALPHA"), plan: plan("# b\n") },
      { pool: t.pool },
    );
    expect(result.replacedRepos).toEqual([{ githubId: 1, owner: "acme", name: "alpha" }]);
    expect(await ids()).toEqual([2]);
  });

  it("without a pool the conflicting row is replaced unguarded (single-writer callers)", async () => {
    await persistRepoSync(t.db, { repo: meta(1, "alpha"), plan: plan("# a\n") });
    const result = await withRepoSyncLock(t.pool, { githubId: 1 }, () =>
      persistRepoSync(t.db, { repo: meta(2, "alpha"), plan: plan("# b\n") }),
    );
    expect(result.acquired && result.value.replacedRepos).toHaveLength(1);
    expect(await ids()).toEqual([2]);
  });

  it("a content plan landing in another row than it was diffed against is stale", async () => {
    const first = await persistRepoSync(t.db, { repo: meta(1, "alpha"), plan: plan("# a\n") });
    // Diffed against a row id that is not this repo's row.
    await expect(
      persistRepoSync(t.db, { repo: meta(1, "alpha"), plan: plan("# a2\n", first.repoId + 100) }),
    ).rejects.toMatchObject({ kind: "stale_plan" });
    // Diffed against no row while a row exists (its documents were never considered).
    await expect(
      persistRepoSync(t.db, { repo: meta(1, "alpha"), plan: plan("# a2\n", null) }),
    ).rejects.toMatchObject({ kind: "stale_plan" });
    // Diffed against a row that is gone: the fresh row is not that row.
    await t.db.delete(repos).where(eq(repos.githubId, 1));
    await expect(
      persistRepoSync(t.db, { repo: meta(1, "alpha"), plan: plan("# a2\n", first.repoId) }),
    ).rejects.toMatchObject({ kind: "stale_plan" });
    expect(await ids()).toEqual([]);
    // Matching ids pass.
    const fresh = await persistRepoSync(t.db, {
      repo: meta(1, "alpha"),
      plan: plan("# a3\n", null),
    });
    const again = await persistRepoSync(t.db, {
      repo: meta(1, "alpha"),
      plan: plan("# a4\n", fresh.repoId),
    });
    expect(again).toMatchObject({ repoId: fresh.repoId, complete: true, updated: 1 });
  });
});
