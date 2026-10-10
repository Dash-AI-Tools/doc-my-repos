import { asc, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAdvisoryLock, withRepoSyncLock } from "../db/advisory-lock";
import { codeOwners, documents, repos, syncRuns, type SyncRepoResult } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { GitHubError } from "../github/client";
import type { RepoLevelResult } from "./blobs";
import {
  PersistError,
  persistRepoSync,
  type PersistFetchedDoc,
  type PersistPlan,
  type PersistRepo,
  type PersistResult,
} from "./persist";
import {
  FATAL_GITHUB_KINDS,
  MAX_RESULT_LIST,
  MAX_RESULT_REPOS,
  MAX_RESULTS_BYTES,
  MAX_RESULT_TEXT,
  REAPED_RUN_ERROR,
  REPO_BUSY_MESSAGE,
  RUN_ABORTED_ERROR,
  RepoSyncError,
  aggregateRunStats,
  computeRunStatus,
  describeSyncError,
  failureEntry,
  finishRun,
  reapStaleRuns,
  recordRepoOutcome,
  removalEntry,
  runRepos,
  startRun,
  successEntry,
  syncRunLockKey,
  withRun,
  type RepoWorkResult,
  type RunRepo,
} from "./runs";

const SECRET = "ghs_SENTINELsecretTOKEN0123456789";
const SECRET_SQL = "SELECT password FROM sentinel_table";

const sha = (n: number | string) => String(n).padStart(40, "0").slice(-40);

function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

function repoMeta(githubId: number, over: Partial<PersistRepo> = {}): PersistRepo {
  return {
    githubId,
    owner: "acme",
    name: `repo${githubId}`,
    description: null,
    defaultBranch: "main",
    archived: false,
    visibility: "public",
    htmlUrl: `https://github.com/acme/repo${githubId}`,
    ...over,
  };
}

function runRepo(githubId: number, over: Partial<RunRepo> = {}): RunRepo {
  return { githubId, owner: "acme", name: `repo${githubId}`, visibility: "public", ...over };
}

function doc(path: string, text: string): PersistFetchedDoc {
  return { path, blobSha: sha(`${path.length}${text.length}`), size: text.length, text };
}

const ABSENT: RepoLevelResult = { state: "absent" };

function content(over: Partial<Extract<PersistPlan, { kind: "content" }>> = {}): PersistPlan {
  return {
    kind: "content",
    treeSha: sha("t1"),
    commitSha: sha("c1"),
    headEtag: null,
    selectionFingerprint: "v1:fp",
    docsFolder: "docs",
    fetched: [],
    removed: [],
    failed: [],
    readme: ABSENT,
    codeowners: ABSENT,
    ...over,
  };
}

function persistResult(over: Partial<PersistResult> = {}): PersistResult {
  return {
    repoId: 1,
    complete: true,
    added: 0,
    updated: 0,
    identical: 0,
    removed: 0,
    skipped: [],
    failed: [],
    warnings: [],
    replacedRepos: [],
    isOkf: false,
    okfVersion: null,
    ...over,
  };
}

describe("describeSyncError", () => {
  it("maps GitHub kinds to fixed messages and flags fatal kinds", () => {
    expect(describeSyncError(new GitHubError("installation_unavailable", 404))).toMatchObject({
      kind: "installation_unavailable",
      message: "GitHub App installation unavailable",
      fatal: true,
    });
    expect(describeSyncError(new GitHubError("not_found", 404))).toMatchObject({
      kind: "not_found",
      fatal: false,
      retryable: false,
    });
    expect(describeSyncError(new GitHubError("forbidden", 403)).fatal).toBe(false);
    expect(describeSyncError(new GitHubError("server", 502))).toMatchObject({
      fatal: false,
      retryable: true,
    });
    for (const kind of [
      "rate_limited",
      "unauthorized",
      "app_credentials",
      "invalid_private_key",
      "installation_unavailable",
      "aborted",
    ] as const) {
      expect(FATAL_GITHUB_KINDS.has(kind)).toBe(true);
      expect(describeSyncError(new GitHubError(kind)).fatal).toBe(true);
    }
  });

  it("gives rate limits a retry time and marks them retryable", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const d = describeSyncError(new GitHubError("rate_limited", 403, 90_500), now);
    expect(d).toMatchObject({ kind: "rate_limited", retryable: true, fatal: true });
    expect(d.retryAt).toBe(now + 90_500);
    expect(d.message).toBe("GitHub rate limit exhausted; retry after 2026-10-10T12:01:31.000Z");
    expect(describeSyncError(new GitHubError("rate_limited", 429)).message).toBe(
      "GitHub rate limit exhausted; retry later",
    );
  });

  it("maps PersistError, RepoSyncError and unknown errors without their messages", () => {
    const db = describeSyncError(new PersistError("database", SECRET_SQL, "23505"));
    expect(db).toMatchObject({ kind: "database", fatal: false });
    expect(db.message).toBe("database error while saving the repository (SQLSTATE 23505)");
    expect(describeSyncError(new PersistError("database", SECRET, `x${SECRET}`)).message).toBe(
      "database error while saving the repository",
    );
    expect(describeSyncError(new PersistError("aborted", SECRET)).fatal).toBe(true);
    expect(describeSyncError(new PersistError("stale_plan", SECRET)).kind).toBe("stale_plan");
    expect(describeSyncError(new RepoSyncError("tree_truncated")).message).toContain("truncated");
    expect(
      describeSyncError(new RepoSyncError("too_many_files", { count: 2500, limit: 2000 })).message,
    ).toBe("too many docs files (2500 found, limit 2000); docs not synced");
    expect(describeSyncError(new RepoSyncError("not_accessible")).message).toBe(
      "not accessible by the GitHub App",
    );
    const unknown = describeSyncError(new Error(`token ${SECRET} body ${SECRET_SQL}`));
    expect(unknown).toMatchObject({ kind: "unexpected", fatal: false });
    for (const e of [unknown, db]) {
      expect(JSON.stringify(e)).not.toContain(SECRET);
      expect(JSON.stringify(e)).not.toContain("sentinel_table");
    }
    expect(describeSyncError("a string").kind).toBe("unexpected");
    expect(describeSyncError(null).kind).toBe("unexpected");
  });
});

describe("results entries and stats", () => {
  it("builds a capped success entry from a persist result", () => {
    const many = Array.from({ length: 120 }, (_, i) => `docs/f${i}.md`);
    const entry = successEntry(runRepo(5), {
      persist: persistResult({
        added: 2,
        updated: 1,
        identical: 4,
        removed: 3,
        skipped: [{ path: "docs/big.md", reason: "too_large" }],
        warnings: many.map((path) => ({ path, message: "x".repeat(MAX_RESULT_TEXT * 2) })),
        replacedRepos: [{ githubId: 9, owner: "acme", name: "old" }],
      }),
      unchanged: false,
      selectionSkipped: [{ path: "docs/node_modules/a.md", reason: "ignored_folder" }],
    });
    expect(entry).toMatchObject({
      repo: "acme/repo5",
      githubId: 5,
      status: "ok",
      error: null,
      added: 2,
      updated: 1,
      identical: 4,
      removed: 3,
      skipped: 2,
      warningsTotal: 120,
      replacedRepos: ["acme/old"],
    });
    expect(entry.skippedFiles).toEqual([
      { path: "docs/big.md", reason: "too_large" },
      { path: "docs/node_modules/a.md", reason: "ignored_folder" },
    ]);
    expect(entry.warnings).toHaveLength(MAX_RESULT_LIST);
    expect(entry.warnings[0]?.message.length).toBeLessThanOrEqual(MAX_RESULT_TEXT);
  });

  it("reports an incomplete persist as an error entry", () => {
    const entry = successEntry(runRepo(5), {
      persist: persistResult({ complete: false, failed: ["docs/a.md", "README.md"] }),
      unchanged: false,
    });
    expect(entry).toMatchObject({
      status: "error",
      errorKind: "incomplete",
      retryable: true,
      failedFiles: ["docs/a.md", "README.md"],
      failedFilesTotal: 2,
    });
    expect(entry.error).toMatch(/^2 files could not be fetched/);
  });

  it("aggregates stats and computes the final status", () => {
    const ok = successEntry(runRepo(1), {
      persist: persistResult({ added: 3, updated: 1, removed: 2, identical: 5 }),
      unchanged: false,
    });
    const same = successEntry(runRepo(2), { persist: persistResult(), unchanged: true });
    const bad = failureEntry(runRepo(3), describeSyncError(new GitHubError("not_found")));
    const busy = failureEntry(
      runRepo(4),
      { kind: "busy", message: REPO_BUSY_MESSAGE, retryable: true, retryAt: null, fatal: false },
      "skipped",
    );
    const gone = removalEntry(runRepo(5), "not_in_installation", 4);
    const stats = aggregateRunStats([ok, same, bad, busy, gone]);
    expect(stats).toEqual({
      reposTotal: 4,
      reposOk: 2,
      reposSynced: 1,
      reposUnchanged: 1,
      reposFailed: 1,
      reposSkipped: 1,
      reposRemoved: 1,
      docsAdded: 3,
      docsUpdated: 1,
      docsRemoved: 6,
      docsIdentical: 5,
      docsSkipped: 0,
      warnings: 0,
    });
    expect(computeRunStatus(stats, null)).toBe("partial");
    expect(computeRunStatus(aggregateRunStats([ok, same, busy]), null)).toBe("success");
    expect(computeRunStatus(aggregateRunStats([]), null)).toBe("success");
    expect(computeRunStatus(aggregateRunStats([gone]), null)).toBe("success");
    expect(gone).toMatchObject({
      status: "removed",
      removalReason: "not_in_installation",
      removed: 4,
      error: null,
    });
    expect(computeRunStatus(aggregateRunStats([bad, busy]), null)).toBe("failed");
    expect(
      computeRunStatus(
        aggregateRunStats([ok]),
        describeSyncError(new GitHubError("installation_unavailable")),
      ),
    ).toBe("failed");
  });
});

describeDb("sync runs on a real database", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  async function seed(githubId: number, over: Partial<PersistRepo> = {}) {
    await persistRepoSync(t.db, {
      repo: repoMeta(githubId, over),
      plan: content({
        fetched: [
          doc("docs/a.md", "# Alpha\n\nbody a\n"),
          doc("docs/b.md", "---\ntype: X\n---\nb\n"),
        ],
        readme: {
          state: "fetched",
          file: { path: "README.md", blobSha: sha("r"), size: 6 },
          text: "# Hi\n",
          warnings: [],
        },
        codeowners: {
          state: "fetched",
          file: { path: ".github/CODEOWNERS", blobSha: sha("o"), size: 12 },
          text: "* @acme/docs\n",
          warnings: [],
        },
      }),
    });
  }

  async function repoRow(githubId: number) {
    const [row] = await t.db.select().from(repos).where(eq(repos.githubId, githubId));
    return row;
  }

  /** Everything a failed sync must leave untouched. */
  async function storedContent(githubId: number) {
    const row = await repoRow(githubId);
    if (!row) return null;
    const docs = await t.db
      .select({
        path: documents.path,
        blobSha: documents.blobSha,
        body: documents.body,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(eq(documents.repoId, row.id))
      .orderBy(asc(documents.path));
    const owners = await t.db
      .select({ pattern: codeOwners.pattern })
      .from(codeOwners)
      .where(eq(codeOwners.repoId, row.id));
    return {
      docs,
      owners,
      readme: [row.readmePath, row.readmeMarkdown, row.readmeSha],
      head: [row.treeSha, row.selectionFingerprint, row.commitSha],
      docsPath: row.docsPath,
      lastSyncedAt: row.lastSyncedAt,
      isOkf: row.isOkf,
    };
  }

  async function runRow(id: number) {
    const [row] = await t.db.select().from(syncRuns).where(eq(syncRuns.id, id));
    return row!;
  }

  /** A worker that persists a real content sync for the repo. */
  const okWorker = async (repo: RunRepo): Promise<RepoWorkResult> => ({
    persist: await persistRepoSync(t.db, {
      repo: repoMeta(repo.githubId),
      plan: content({ fetched: [doc("docs/a.md", "# Alpha v2\n")], removed: [] }),
    }),
    unchanged: false,
  });

  async function runLockFree(runId: number): Promise<boolean> {
    const res = await withAdvisoryLock(t.pool, syncRunLockKey(runId), async () => true);
    return res.acquired;
  }

  describe("recordRepoOutcome", () => {
    it("records ok and error on an existing row and keeps content", async () => {
      await seed(10);
      const before = await storedContent(10);
      expect(
        await recordRepoOutcome(t.db, { githubId: 10 }, { status: "error", message: "boom" }),
      ).toBe(true);
      expect(await repoRow(10)).toMatchObject({ syncStatus: "error", syncError: "boom" });
      expect(await storedContent(10)).toEqual(before);
      expect(await recordRepoOutcome(t.db, { githubId: 10 }, { status: "ok" })).toBe(true);
      const row = await repoRow(10);
      expect(row).toMatchObject({ syncStatus: "ok", syncError: null });
      expect(row!.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(before!.lastSyncedAt!.getTime());
    });

    it("applies GitHub's visibility on the error path, failing closed", async () => {
      await seed(11);
      await recordRepoOutcome(
        t.db,
        { githubId: 11 },
        { status: "error", message: "x", visibility: "internal" },
      );
      expect((await repoRow(11))?.visibility).toBe("private");
    });

    it("does not create a row for a repo that was never synced", async () => {
      expect(
        await recordRepoOutcome(t.db, { githubId: 12 }, { status: "error", message: "x" }),
      ).toBe(false);
      expect(await repoRow(12)).toBeUndefined();
    });
  });

  describe("runRepos failure isolation", () => {
    it("keeps going after per-repo failures, keeps their content and records safe errors", async () => {
      await seed(20);
      await seed(21);
      await seed(22);
      const before20 = await storedContent(20);
      const before21 = await storedContent(21);
      const seen: number[] = [];
      const { results, fatal } = await runRepos(
        t.db,
        t.pool,
        [runRepo(20), runRepo(21), runRepo(22), runRepo(23), runRepo(24, { name: "new" })],
        async (repo, { signal }) => {
          expect(signal.aborted).toBe(false);
          seen.push(repo.githubId);
          if (repo.githubId === 20) throw new GitHubError("not_found", 404);
          if (repo.githubId === 21) throw new PersistError("database", SECRET_SQL, "23505");
          if (repo.githubId === 23) throw new Error(`leaked ${SECRET}`);
          return okWorker(repo);
        },
      );
      expect(fatal).toBeNull();
      expect(seen).toEqual([20, 21, 22, 23, 24]);
      expect(results.map((r) => [r.githubId, r.status, r.errorKind])).toEqual([
        [20, "error", "not_found"],
        [21, "error", "database"],
        [22, "ok", null],
        [23, "error", "unexpected"],
        [24, "ok", null],
      ]);
      expect(await repoRow(20)).toMatchObject({
        syncStatus: "error",
        syncError: describeSyncError(new GitHubError("not_found")).message,
      });
      expect(await repoRow(21)).toMatchObject({
        syncStatus: "error",
        syncError: "database error while saving the repository (SQLSTATE 23505)",
      });
      expect(await storedContent(20)).toEqual(before20);
      expect(await storedContent(21)).toEqual(before21);
      expect(await repoRow(22)).toMatchObject({ syncStatus: "ok", syncError: null });
      // First sync failed: no row, the failure is only in the results.
      expect(await repoRow(23)).toBeUndefined();
      expect(results[3]?.error).toBe("unexpected error during sync");
      const json = JSON.stringify(results);
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain("sentinel_table");
    });

    it("records an incomplete persist as an error with the arrived content", async () => {
      await seed(25);
      const { results } = await runRepos(t.db, t.pool, [runRepo(25)], async (repo) => ({
        persist: await persistRepoSync(t.db, {
          repo: repoMeta(repo.githubId),
          plan: content({
            fetched: [doc("docs/a.md", "# New A\n")],
            failed: [{ path: "docs/b.md" }],
          }),
        }),
        unchanged: false,
      }));
      expect(results[0]).toMatchObject({
        status: "error",
        errorKind: "incomplete",
        added: 0,
        updated: 1,
      });
      const row = await repoRow(25);
      expect(row?.syncStatus).toBe("error");
      expect(row?.syncError).toMatch(/^1 file could not be fetched/);
      const content25 = await storedContent(25);
      expect(content25?.docs.map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);
    });

    it("stops on a fatal rate limit and reports the rest as skipped, untouched", async () => {
      await seed(30);
      await seed(31);
      await seed(32);
      await seed(33);
      const before32 = await repoRow(32);
      const before31 = await storedContent(31);
      const seen: number[] = [];
      const { results, fatal } = await runRepos(
        t.db,
        t.pool,
        [runRepo(30), runRepo(31), runRepo(32), runRepo(33)],
        async (repo) => {
          seen.push(repo.githubId);
          if (repo.githubId === 31) throw new GitHubError("rate_limited", 403, 120_000);
          return okWorker(repo);
        },
      );
      expect(seen).toEqual([30, 31]);
      expect(fatal?.kind).toBe("rate_limited");
      expect(results.map((r) => [r.githubId, r.status])).toEqual([
        [30, "ok"],
        [31, "error"],
        [32, "skipped"],
        [33, "skipped"],
      ]);
      expect(results[2]?.error).toMatch(/^GitHub rate limit exhausted; retry after /);
      expect(results[2]?.retryable).toBe(true);
      expect(results[2]?.retryAfter).not.toBeNull();
      expect((await repoRow(31))?.syncStatus).toBe("error");
      expect(await storedContent(31)).toEqual(before31);
      // Not installation-wide: the unreached repos' rows are untouched.
      expect(await repoRow(32)).toEqual(before32);
    });

    it("marks every unreached repo errored when the installation is unavailable", async () => {
      await seed(40);
      await seed(41, { visibility: "public" });
      const before41 = await storedContent(41);
      const { results, fatal } = await runRepos(
        t.db,
        t.pool,
        [runRepo(40), runRepo(41, { visibility: "private" }), runRepo(42)],
        async () => {
          throw new GitHubError("installation_unavailable", 404);
        },
      );
      expect(fatal?.kind).toBe("installation_unavailable");
      expect(results.map((r) => r.status)).toEqual(["error", "skipped", "skipped"]);
      for (const id of [40, 41]) {
        expect(await repoRow(id)).toMatchObject({
          syncStatus: "error",
          syncError: "GitHub App installation unavailable",
        });
      }
      expect((await repoRow(41))?.visibility).toBe("private");
      expect(await storedContent(41)).toEqual(before41);
      expect(await repoRow(42)).toBeUndefined();
    });

    it("records a fatal error per repo and continues with continueOnFatal", async () => {
      const seen: number[] = [];
      const { results, fatal } = await runRepos(
        t.db,
        t.pool,
        [runRepo(50), runRepo(51)],
        async (repo) => {
          seen.push(repo.githubId);
          throw new GitHubError("rate_limited", 429);
        },
        { continueOnFatal: true },
      );
      expect(seen).toEqual([50, 51]);
      expect(fatal).toBeNull();
      expect(results.map((r) => r.status)).toEqual(["error", "error"]);
    });

    it("skips a repo whose sync lock is busy without touching it", async () => {
      await seed(60);
      const before = await repoRow(60);
      const held = gate();
      const release = gate();
      const holder = withRepoSyncLock(t.pool, { githubId: 60 }, async () => {
        held.open();
        await release.promise;
      });
      await held.promise;
      try {
        const { results, fatal } = await runRepos(t.db, t.pool, [runRepo(60)], async () => {
          throw new Error("must not run");
        });
        expect(fatal).toBeNull();
        expect(results[0]).toMatchObject({ status: "skipped", error: REPO_BUSY_MESSAGE });
      } finally {
        release.open();
        await holder;
      }
      expect(await repoRow(60)).toEqual(before);
    });

    it("stops before any repo when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { results, fatal } = await runRepos(
        t.db,
        t.pool,
        [runRepo(70), runRepo(71)],
        async () => {
          throw new Error("must not run");
        },
        { signal: controller.signal },
      );
      expect(fatal?.kind).toBe("aborted");
      expect(results.map((r) => [r.status, r.error])).toEqual([
        ["skipped", RUN_ABORTED_ERROR],
        ["skipped", RUN_ABORTED_ERROR],
      ]);
    });

    it("an abort during a repo stops the run without marking that repo errored", async () => {
      await seed(72);
      const before = await repoRow(72);
      const controller = new AbortController();
      const { results, fatal } = await runRepos(
        t.db,
        t.pool,
        [runRepo(72), runRepo(73)],
        async () => {
          controller.abort();
          throw new GitHubError("aborted");
        },
        { signal: controller.signal },
      );
      expect(fatal?.kind).toBe("aborted");
      expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
      expect(await repoRow(72)).toEqual(before);
    });

    it("isolates failures with concurrency 2 too", async () => {
      const { results } = await runRepos(
        t.db,
        t.pool,
        [runRepo(80), runRepo(81), runRepo(82)],
        async (repo) => {
          if (repo.githubId === 81) throw new GitHubError("server", 502);
          return okWorker(repo);
        },
        { concurrency: 2 },
      );
      expect(results.map((r) => [r.githubId, r.status])).toEqual([
        [80, "ok"],
        [81, "error"],
        [82, "ok"],
      ]);
    });
  });

  describe("withRun", () => {
    it("holds the run lock for the run, writes success with stats, and releases it", async () => {
      let runIdSeen = 0;
      const result = await withRun(
        t.db,
        t.pool,
        { trigger: "manual", scope: null },
        async ({ runId, ledger, signal }) => {
          runIdSeen = runId;
          expect(signal.aborted).toBe(false);
          expect(await runLockFree(runId)).toBe(false);
          expect((await runRow(runId)).status).toBe("running");
          ledger.add(await runRepos(t.db, t.pool, [runRepo(100), runRepo(101)], okWorker));
          return "value";
        },
      );
      expect(result).toMatchObject({ ran: true, value: "value", written: true, status: "success" });
      if (!result.ran) throw new Error("unreachable");
      expect(result.stats).toMatchObject({ reposTotal: 2, reposSynced: 2, docsAdded: 2 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(await runLockFree(runIdSeen)).toBe(true);
      const row = await runRow(runIdSeen);
      expect(row).toMatchObject({
        trigger: "manual",
        scope: null,
        status: "success",
        reposTotal: 2,
        reposSynced: 2,
        reposFailed: 0,
        docsAdded: 2,
        error: null,
      });
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(row.results.map((r) => r.repo)).toEqual(["acme/repo100", "acme/repo101"]);
    });

    it("writes partial when some repos fail and failed when all do", async () => {
      const partial = await withRun(
        t.db,
        t.pool,
        { trigger: "schedule", scope: null },
        async ({ ledger }) => {
          ledger.add(
            await runRepos(t.db, t.pool, [runRepo(110), runRepo(111)], async (repo) => {
              if (repo.githubId === 111) throw new GitHubError("not_found", 404);
              return okWorker(repo);
            }),
          );
        },
      );
      expect(partial).toMatchObject({ ran: true, status: "partial" });
      const p = await runRow(partial.runId);
      expect(p).toMatchObject({ status: "partial", reposSynced: 1, reposFailed: 1, error: null });

      const failed = await withRun(
        t.db,
        t.pool,
        { trigger: "webhook", scope: "acme/repo112" },
        async ({ ledger }) => {
          ledger.add(
            await runRepos(t.db, t.pool, [runRepo(112)], async () => {
              throw new GitHubError("forbidden", 403);
            }),
          );
        },
      );
      expect(failed).toMatchObject({ ran: true, status: "failed" });
      expect(await runRow(failed.runId)).toMatchObject({
        status: "failed",
        scope: "acme/repo112",
        reposFailed: 1,
      });
    });

    it("writes failed with the fatal message when a run stops", async () => {
      const result = await withRun(
        t.db,
        t.pool,
        { trigger: "manual", scope: null },
        async ({ ledger }) => {
          ledger.add(
            await runRepos(t.db, t.pool, [runRepo(120), runRepo(121)], async () => {
              throw new GitHubError("installation_unavailable", 404);
            }),
          );
        },
      );
      expect(await runRow(result.runId)).toMatchObject({
        status: "failed",
        error: "GitHub App installation unavailable",
        reposTotal: 2,
        reposFailed: 1,
      });
    });

    it("marks the run failed with a safe message, rethrows, and releases the lock on throw", async () => {
      let runId = 0;
      const boom = new Error(`boom ${SECRET}`);
      await expect(
        withRun(t.db, t.pool, { trigger: "manual", scope: null }, async (ctx) => {
          runId = ctx.runId;
          ctx.ledger.add(await runRepos(t.db, t.pool, [runRepo(130)], okWorker));
          throw boom;
        }),
      ).rejects.toBe(boom);
      const row = await runRow(runId);
      expect(row).toMatchObject({
        status: "failed",
        error: "unexpected error during sync",
        reposSynced: 1,
      });
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(await runLockFree(runId)).toBe(true);
    });

    it("does not overwrite a row that was failed (reaped) during the run", async () => {
      const result = await withRun(
        t.db,
        t.pool,
        { trigger: "manual", scope: null },
        async ({ runId, ledger }) => {
          await t.db
            .update(syncRuns)
            .set({ status: "failed", error: REAPED_RUN_ERROR, finishedAt: sql`now()` })
            .where(eq(syncRuns.id, runId));
          ledger.add(await runRepos(t.db, t.pool, [runRepo(140)], okWorker));
        },
      );
      expect(result).toMatchObject({ ran: true, written: false });
      expect(await runRow(result.runId)).toMatchObject({
        status: "failed",
        error: REAPED_RUN_ERROR,
        reposTotal: 0,
      });
      // finishRun on its own is conditional too.
      expect((await finishRun(t.db, result.runId, { results: [], fatal: null })).written).toBe(
        false,
      );
    });

    it("stops without running when the row was reaped before the run lock was taken", async () => {
      // A pool whose first connect is delayed past a reaper that fails the new row.
      const delayed = {
        connect: async () => {
          await t.db
            .update(syncRuns)
            .set({ status: "failed", error: REAPED_RUN_ERROR })
            .where(runningWithTrigger("startup"));
          return t.pool.connect();
        },
      } as unknown as Pool;
      let ran = false;
      const result = await withRun(t.db, delayed, { trigger: "startup", scope: null }, async () => {
        ran = true;
      });
      expect(ran).toBe(false);
      expect(result).toMatchObject({ ran: false, reason: "reaped" });
      expect(await runRow(result.runId)).toMatchObject({
        status: "failed",
        error: REAPED_RUN_ERROR,
      });
      expect(await runLockFree(result.runId)).toBe(true);
    });

    it("fails its own row when aborted before it starts", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await withRun(
        t.db,
        t.pool,
        { trigger: "manual", scope: null, signal: controller.signal },
        async () => {
          throw new Error("must not run");
        },
      );
      expect(result).toMatchObject({ ran: false, reason: "aborted" });
      expect(await runRow(result.runId)).toMatchObject({
        status: "failed",
        error: RUN_ABORTED_ERROR,
      });
    });

    it("bounds the results JSON", async () => {
      const big: SyncRepoResult[] = Array.from({ length: MAX_RESULT_REPOS + 100 }, (_, i) =>
        successEntry(runRepo(1000 + i), {
          persist: persistResult({
            added: 1,
            warnings: Array.from({ length: 200 }, (_, j) => ({
              path: `docs/${"p".repeat(2000)}${j}.md`,
              message: "w".repeat(5000),
            })),
          }),
          unchanged: false,
        }),
      );
      const runId = await startRun(t.db, { trigger: "manual", scope: null });
      const finished = await finishRun(t.db, runId, { results: big, fatal: null });
      expect(finished).toMatchObject({ written: true, status: "success" });
      const row = await runRow(runId);
      expect(row.results).toHaveLength(MAX_RESULT_REPOS);
      expect(row.reposTotal).toBe(MAX_RESULT_REPOS + 100);
      expect(row.docsAdded).toBe(MAX_RESULT_REPOS + 100);
      expect(row.results[0]?.warningsTotal).toBe(200);
      expect(row.results[0]?.warnings).toHaveLength(MAX_RESULT_LIST);
      // Past the byte budget, entries keep counts but drop their lists.
      const last = row.results[MAX_RESULT_REPOS - 1];
      expect(last).toMatchObject({ warnings: [], warningsTotal: 200, added: 1, status: "ok" });
      // The budget plus a small fixed entry per repo.
      expect(JSON.stringify(row.results).length).toBeLessThan(
        MAX_RESULTS_BYTES + MAX_RESULT_REPOS * 1024,
      );
    });
  });

  describe("reapStaleRuns", () => {
    async function backdate(runId: number, ms: number) {
      await t.db
        .update(syncRuns)
        .set({ startedAt: sql`now() - make_interval(secs => ${ms / 1000})` })
        .where(eq(syncRuns.id, runId));
    }

    it("reaps a stale run whose lock is free, conditionally and with a fixed error", async () => {
      const id = await startRun(t.db, { trigger: "manual", scope: null });
      await backdate(id, 5 * 60_000);
      const reaped = await reapStaleRuns(t.db, t.pool);
      expect(reaped).toContain(id);
      expect(await runRow(id)).toMatchObject({ status: "failed", error: REAPED_RUN_ERROR });
      expect((await runRow(id)).finishedAt).toBeInstanceOf(Date);
      expect(await reapStaleRuns(t.db, t.pool)).not.toContain(id);
    });

    it("never reaps inside the grace period", async () => {
      const id = await startRun(t.db, { trigger: "manual", scope: null });
      await backdate(id, 30_000);
      expect(await reapStaleRuns(t.db, t.pool)).not.toContain(id);
      expect((await runRow(id)).status).toBe("running");
      // An explicit reference time past the grace period does reap it.
      const later = new Date(Date.now() + 120_000);
      expect(await reapStaleRuns(t.db, t.pool, { now: later })).toContain(id);
    });

    it("never reaps a live run that holds its lock, even long after start", async () => {
      const inside = gate<number>();
      const release = gate();
      const run = withRun(t.db, t.pool, { trigger: "manual", scope: null }, async ({ runId }) => {
        inside.open(runId);
        await release.promise;
      });
      const id = await inside.promise;
      try {
        await backdate(id, 60 * 60_000);
        expect(await reapStaleRuns(t.db, t.pool)).not.toContain(id);
        expect((await runRow(id)).status).toBe("running");
      } finally {
        release.open();
      }
      const result = await run;
      expect(result).toMatchObject({ ran: true, written: true, status: "success" });
      expect((await runRow(id)).status).toBe("success");
    });

    it("is safe to run concurrently: each stale run is reaped exactly once", async () => {
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await startRun(t.db, { trigger: "schedule", scope: null });
        await backdate(id, 10 * 60_000);
        ids.push(id);
      }
      const [a, b] = await Promise.all([reapStaleRuns(t.db, t.pool), reapStaleRuns(t.db, t.pool)]);
      const all = [...a!, ...b!].filter((id) => ids.includes(id));
      expect(all.sort((x, y) => x - y)).toEqual(ids);
      for (const id of ids) expect((await runRow(id)).status).toBe("failed");
    });

    it("rejects an invalid grace period", async () => {
      await expect(reapStaleRuns(t.db, t.pool, { graceMs: Number.NaN })).rejects.toThrow(TypeError);
      await expect(reapStaleRuns(t.db, t.pool, { graceMs: -1 })).rejects.toThrow(TypeError);
    });
  });

  /** Running rows with this trigger (used to fail the next row before its lock is taken). */
  function runningWithTrigger(trigger: "startup") {
    return sql`${syncRuns.status} = 'running' and ${syncRuns.trigger} = ${trigger}`;
  }
});
