import { asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { configSchema } from "../config/schema";
import { repoSyncLockKey, withAdvisoryLock, withRepoSyncLock } from "../db/advisory-lock";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { markRepoPrivate } from "../webhooks/store";
import {
  createSyncContext,
  drainSyncRequests,
  requestSync,
  syncAll,
  type RequestSyncHooks,
  type RequestSyncResult,
  type SyncContext,
} from "./engine";
import { FakeGitHub, type FakeRepoInit } from "./fake-github";
import {
  clearSyncRequest,
  databaseInstant,
  isSyncRequested,
  listSyncRequests,
  markSyncRequested,
  writtenSince,
} from "./requests";
import { SUPERSEDED_MESSAGE, startRun, syncRunLockKey } from "./runs";

// Task 6.4: idempotent processing and per-repo coalescing, against a real database and the
// fixture-backed fake GitHub. Interleavings are forced with hooks and paused fake requests, never
// with sleeps.

const HANDBOOK_ID = 101;
const METRICS_ID = 202;

const HANDBOOK_BRANCH = /^\/repos\/acme\/handbook\/branches\//;
const HANDBOOK_BLOBS = /^\/repos\/acme\/handbook\/git\/blobs\//;
const HANDBOOK_TREES = /^\/repos\/acme\/handbook\/git\/trees\//;
const METRICS_BRANCH = /^\/repos\/acme\/metrics\/branches\//;
const LISTING = /^\/installation\/repositories$/;

function metrics(): FakeRepoInit {
  return { id: METRICS_ID, name: "metrics", files: { "docs/m.md": "# M\n" } };
}

function handbook(): FakeRepoInit {
  return {
    id: HANDBOOK_ID,
    name: "handbook",
    files: { "README.md": "# Handbook\n", "docs/a.md": "# A v1\n", "docs/b.md": "# B\n" },
  };
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** Releases of every gate a test opened, so a failing test cannot leave a sync paused. */
const openGates: (() => void)[] = [];

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  openGates.push(() => resolve(undefined as T));
  return { promise, resolve };
}

/** Pauses the first fake GitHub request matching `pattern` until `release()`. */
function pauseOnce(fake: FakeGitHub, pattern: RegExp) {
  const reached = deferred();
  const release = deferred();
  let used = false;
  fake.onRequest = async (request) => {
    if (used || !pattern.test(request.path)) return;
    used = true;
    reached.resolve();
    await release.promise;
  };
  return { reached: reached.promise, release: () => release.resolve() };
}

/** Counts passes and the most that ever ran at once (hooks run under the repo lock). */
function passMeter() {
  const meter = { passes: 0, inFlight: 0, max: 0 };
  const hooks: RequestSyncHooks = {
    passStart: () => {
      meter.passes++;
      meter.inFlight++;
      meter.max = Math.max(meter.max, meter.inFlight);
    },
    beforeUnlock: () => {
      meter.inFlight--;
    },
  };
  return { meter, hooks };
}

describeDb("coalesced, idempotent syncs (task 6.4)", () => {
  vi.setConfig({ testTimeout: 30_000 });
  let testDb: TestDatabase;
  let h: DbHandle;
  let fake: FakeGitHub;
  let ctx: SyncContext;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // Room for a holder (run lock, repo lock, queries) plus waiting requesters and test locks.
    h = createDb(testDb.url.reveal(), { max: 20 });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  function contextFor(github: FakeGitHub): SyncContext {
    return createSyncContext({
      db: h.db,
      pool: h.pool,
      github: createGitHubClient({
        getToken: github.getToken,
        fetch: github.fetch,
        sleep: async () => undefined,
        maxWaitMs: 1_000,
      }),
      config: configSchema.parse({}),
    });
  }

  afterEach(() => {
    for (const release of openGates.splice(0)) release();
  });

  beforeEach(async () => {
    await h.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
    fake = new FakeGitHub({ owner: "acme", repos: [metrics(), handbook()] });
    ctx = contextFor(fake);
  });

  async function initialSync() {
    const result = await syncAll(ctx, { trigger: "manual" });
    expect(result.fatal).toBeNull();
    fake.clearRequests();
  }

  async function repoRow(githubId: number) {
    const [row] = await h.db.select().from(repos).where(eq(repos.githubId, githubId));
    return row;
  }

  async function body(githubId: number, path: string) {
    const [row] = await h.db
      .select({ body: documents.body })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(sql`${repos.githubId} = ${githubId} and ${documents.path} = ${path}`);
    return row?.body;
  }

  const requested = () => listSyncRequests(h.db);
  const webhook = { trigger: "webhook" as const };

  // -------------------------------------------------------------------------------------------
  // The marker store

  it("marker: needs a row, never moves backwards, clears only what a pass covers", async () => {
    expect(await markSyncRequested(h.db, HANDBOOK_ID)).toBe(false);
    expect(await isSyncRequested(h.db, HANDBOOK_ID)).toBe(false);
    await initialSync();

    const before = await databaseInstant(h.db);
    expect(await markSyncRequested(h.db, HANDBOOK_ID)).toBe(true);
    const [first] = await h.db
      .select({ at: repos.syncRequestedAt })
      .from(repos)
      .where(eq(repos.githubId, HANDBOOK_ID));
    // A pass that started before the request does not cover it.
    expect(await clearSyncRequest(h.db, HANDBOOK_ID, before)).toBe(false);
    expect(await isSyncRequested(h.db, HANDBOOK_ID)).toBe(true);

    // A later marker write keeps the later time (greatest), even if it carries an older clock.
    await h.db.execute(
      sql`update repos set sync_requested_at = now() + interval '1 hour' where github_id = ${HANDBOOK_ID}`,
    );
    await markSyncRequested(h.db, HANDBOOK_ID);
    const [later] = await h.db
      .select({ at: repos.syncRequestedAt })
      .from(repos)
      .where(eq(repos.githubId, HANDBOOK_ID));
    expect(later!.at!.getTime()).toBeGreaterThan(first!.at!.getTime() + 30 * 60_000);
    expect(await clearSyncRequest(h.db, HANDBOOK_ID, await databaseInstant(h.db))).toBe(false);

    await h.db
      .update(repos)
      .set({ syncRequestedAt: sql`now() - interval '1 second'` })
      .where(eq(repos.githubId, HANDBOOK_ID));
    await markSyncRequested(h.db, METRICS_ID);
    // Oldest request first.
    expect(await requested()).toEqual([HANDBOOK_ID, METRICS_ID]);
    const now = await databaseInstant(h.db);
    expect(await clearSyncRequest(h.db, HANDBOOK_ID, now)).toBe(true);
    expect(await requested()).toEqual([METRICS_ID]);

    // Instants keep microseconds, so the comparison with updated_at is exact.
    expect(now).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect(await writtenSince(h.db, HANDBOOK_ID, now)).toBe(false);
    await h.db
      .update(repos)
      .set({ updatedAt: sql`now()` })
      .where(eq(repos.githubId, HANDBOOK_ID));
    expect(await writtenSince(h.db, HANDBOOK_ID, now)).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // Coalescing

  it("concurrent requests for one repo never run two passes at once and coalesce into two passes", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    const pause = pauseOnce(fake, HANDBOOK_BRANCH);
    const { meter, hooks } = passMeter();

    const first = requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks });
    await pause.reached;
    const others = await Promise.all(
      Array.from({ length: 9 }, () =>
        requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks }),
      ),
    );
    expect(others.map((r) => r.status)).toEqual(Array(9).fill("coalesced"));
    // Coalesced requests do not touch GitHub: the only listing so far is the holder's.
    expect(fake.requestsTo(LISTING)).toHaveLength(1);
    pause.release();

    expect(await first).toMatchObject({ status: "done", passes: 2, handedOff: false });
    expect(meter).toEqual({ passes: 2, inFlight: 0, max: 1 });
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v2\n");
    // The rerun short-circuits on the unchanged head: one tree and one blob fetch in total.
    expect(fake.requestsTo(HANDBOOK_TREES)).toHaveLength(1);
    expect(fake.requestsTo(HANDBOOK_BLOBS)).toHaveLength(1);
    expect(await requested()).toEqual([]);
  });

  it("a push that lands after the running pass fetched its tree is synced by exactly one rerun", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    const pause = pauseOnce(fake, HANDBOOK_BLOBS);
    const { meter, hooks } = passMeter();

    const first = requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks });
    await pause.reached; // pass 1 already has the v2 tree
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v3\n"); // push B
    const second = await requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks });
    expect(second).toEqual({ status: "coalesced", passes: 0 });
    pause.release();

    const result = await first;
    expect(result).toMatchObject({ status: "done", passes: 2, handedOff: false });
    expect(meter.max).toBe(1);
    // Without the marker, v2 would be the final state until some later trigger.
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v3\n");
    expect(await requested()).toEqual([]);
    expect((await repoRow(HANDBOOK_ID))?.syncStatus).toBe("ok");
  });

  it("a request that arrives after the pass but before the unlock is rerun (no lost wakeup)", async () => {
    await initialSync();
    let inner: RequestSyncResult | undefined;
    const result = await requestSync(
      ctx,
      { githubId: HANDBOOK_ID },
      {
        ...webhook,
        hooks: {
          beforeUnlock: async (pass) => {
            if (pass !== 1) return;
            fake.setFile(HANDBOOK_ID, "docs/a.md", "# A late\n");
            inner = await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook);
          },
        },
      },
    );
    expect(inner).toEqual({ status: "coalesced", passes: 0 });
    expect(result).toMatchObject({ status: "done", passes: 2 });
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A late\n");
    expect(await requested()).toEqual([]);
  });

  it("a request that arrives between the unlock and the recheck runs its own pass, never in parallel", async () => {
    await initialSync();
    const { meter, hooks } = passMeter();
    let inner: Promise<RequestSyncResult> | undefined;
    let pause: ReturnType<typeof pauseOnce> | undefined;
    const result = await requestSync(
      ctx,
      { githubId: HANDBOOK_ID },
      {
        ...webhook,
        hooks: {
          ...hooks,
          afterUnlock: async (pass) => {
            if (pass !== 1) return;
            fake.setFile(HANDBOOK_ID, "docs/a.md", "# A between\n");
            pause = pauseOnce(fake, HANDBOOK_BRANCH);
            inner = requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks });
            await pause.reached; // the newcomer holds the lock, its marker is set
          },
        },
      },
    );
    // The first caller saw the marker, found the lock busy, and left the request to its holder.
    expect(result).toMatchObject({ status: "done", passes: 1, handedOff: true });
    pause?.release();
    expect(await inner).toMatchObject({ status: "done", passes: 1, handedOff: false });
    expect(meter).toMatchObject({ passes: 2, max: 1 });
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A between\n");
    expect(await requested()).toEqual([]);
  });

  it("different repositories sync in parallel", async () => {
    await initialSync();
    const pause = pauseOnce(fake, HANDBOOK_BRANCH);
    const slow = requestSync(ctx, { githubId: HANDBOOK_ID }, webhook);
    await pause.reached;
    fake.setFile(METRICS_ID, "docs/m.md", "# M v2\n");
    expect(await requestSync(ctx, { githubId: METRICS_ID }, webhook)).toMatchObject({
      status: "done",
      passes: 1,
    });
    expect(await body(METRICS_ID, "docs/m.md")).toBe("# M v2\n");
    pause.release();
    expect(await slow).toMatchObject({ status: "done", passes: 1 });
  });

  it("decides busy by the repo lock and the marker only, never by sync_runs or the run lock", async () => {
    await initialSync();
    // A `running` run row for this repo and its run lock held: neither blocks a request.
    const runId = await startRun(h.db, { trigger: "webhook", scope: "acme/handbook" });
    const held = await withAdvisoryLock(h.pool, syncRunLockKey(runId), () =>
      requestSync(ctx, { githubId: HANDBOOK_ID }, webhook),
    );
    expect(held.acquired && held.value).toMatchObject({ status: "done", passes: 1 });
    const [row] = await h.db.select().from(syncRuns).where(eq(syncRuns.id, runId));
    expect(row?.status).toBe("running");
  });

  it("bounds the passes of one call and re-arms a still-waiting request", async () => {
    await initialSync();
    let started = 0;
    // A push during each of the first three passes (after their listing), as on a busy repository.
    fake.onRequest = async (request) => {
      if (HANDBOOK_BRANCH.test(request.path) && ++started <= 3) {
        await markSyncRequested(h.db, HANDBOOK_ID);
      }
    };
    const rearmed: Promise<void>[] = [];
    const options = {
      ...webhook,
      maxPasses: 3,
      rearm: (task: Promise<void>) => rearmed.push(task),
    };
    const result = await requestSync(ctx, { githubId: HANDBOOK_ID }, options);
    expect(result).toMatchObject({ status: "done", passes: 3, handedOff: true });
    expect(rearmed).toHaveLength(1);
    // The follow-up call runs the fourth pass, which no push interrupts.
    await rearmed[0];
    expect(started).toBe(4);
    expect(rearmed).toHaveLength(1);
    expect(await requested()).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Failures, aborts, crashes

  it("a failed pass consumes the requests it covered, keeps content, and does not loop", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    fake.fail({ path: HANDBOOK_TREES, status: 500 });
    const failed = await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook);
    expect(failed).toMatchObject({ status: "done", passes: 1, handedOff: false });
    if (failed.status !== "done" || failed.result.status !== "synced") throw new Error("shape");
    expect(failed.result.result?.status).toBe("error");
    expect(await requested()).toEqual([]);
    expect((await repoRow(HANDBOOK_ID))?.syncStatus).toBe("error");
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v1\n");

    fake.clearFailures();
    await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v2\n");
  });

  it("an aborted pass leaves its request recorded for the next drain", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    const pause = pauseOnce(fake, HANDBOOK_BRANCH);
    const controller = new AbortController();
    const pending = requestSync(
      ctx,
      { githubId: HANDBOOK_ID },
      { ...webhook, signal: controller.signal },
    );
    await pause.reached;
    controller.abort();
    pause.release();
    expect((await pending).status).toBe("aborted");
    expect(await requested()).toEqual([HANDBOOK_ID]);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v1\n");

    expect(await drainSyncRequests(ctx, webhook)).toEqual([
      { githubId: HANDBOOK_ID, status: "done", passes: 1 },
    ]);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v2\n");
    expect(await requested()).toEqual([]);
  });

  it("a crashed holder frees the lock with its connection; the request survives and is drained", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    const crashed = new pg.Client({ connectionString: testDb.url.reveal() });
    crashed.on("error", () => undefined);
    await crashed.connect();
    try {
      await crashed.query("select pg_advisory_lock($1::bigint)", [
        repoSyncLockKey({ githubId: HANDBOOK_ID }),
      ]);
      const { rows } = await crashed.query<{ pid: number }>("select pg_backend_pid() as pid");
      const pid = rows[0]!.pid;

      expect(await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook)).toEqual({
        status: "coalesced",
        passes: 0,
      });
      // The holder's process dies mid-sync.
      await h.pool.query("select pg_terminate_backend($1)", [pid]);
      for (let i = 0; i < 200; i++) {
        const gone = await h.pool.query("select 1 from pg_stat_activity where pid = $1", [pid]);
        if (gone.rowCount === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await crashed.end().catch(() => undefined);
    }
    expect(await requested()).toEqual([HANDBOOK_ID]);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v1\n");

    expect(await drainSyncRequests(ctx, { trigger: "startup" })).toEqual([
      { githubId: HANDBOOK_ID, status: "done", passes: 1 },
    ]);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v2\n");
    expect(await requested()).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Repos with no stored row (first sync)

  it("a never-synced repo cannot hold a marker: busy at once without a queue wait", async () => {
    const result = await withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, () =>
      requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, queueWaitMs: 0 }),
    );
    expect(result.acquired && result.value).toEqual({ status: "busy", passes: 0 });
    expect(await repoRow(HANDBOOK_ID)).toBeUndefined();
  });

  it("a never-synced repo's request waits for the lock and then runs its own pass", async () => {
    const started = deferred();
    const release = deferred();
    const external = withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const sleeps: number[] = [];
    const marks: boolean[] = [];
    const result = await requestSync(
      ctx,
      { githubId: HANDBOOK_ID },
      {
        ...webhook,
        hooks: {
          afterMark: ({ marked }) => void marks.push(marked),
          sleep: async (ms) => {
            sleeps.push(ms);
            release.resolve();
            await external;
          },
        },
      },
    );
    expect(marks).toEqual([false]);
    expect(sleeps).toEqual([50]);
    expect(result).toMatchObject({ status: "done", passes: 1 });
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v1\n");
  });

  it("a never-synced repo's request coalesces once the holder's first sync created the row", async () => {
    const pause = pauseOnce(fake, HANDBOOK_BRANCH);
    const persisted = deferred();
    const hold = deferred();
    const { meter, hooks } = passMeter();
    const first = requestSync(
      ctx,
      { githubId: HANDBOOK_ID },
      {
        ...webhook,
        hooks: {
          ...hooks,
          beforeUnlock: async (pass) => {
            hooks.beforeUnlock?.(pass);
            if (pass !== 1) return;
            persisted.resolve();
            await hold.promise;
          },
        },
      },
    );
    await pause.reached; // first sync running, no row yet
    const marks: boolean[] = [];
    const second = await requestSync(
      ctx,
      { githubId: HANDBOOK_ID },
      {
        ...webhook,
        hooks: {
          afterMark: ({ marked }) => void marks.push(marked),
          sleep: async () => {
            pause.release();
            await persisted.promise; // the row exists, the holder still holds the lock
          },
        },
      },
    );
    expect(marks).toEqual([false]);
    expect(second).toEqual({ status: "coalesced", passes: 0 });
    expect(await requested()).toEqual([HANDBOOK_ID]);
    hold.resolve();
    expect(await first).toMatchObject({ status: "done", passes: 2, handedOff: false });
    expect(meter.max).toBe(1);
    expect(await requested()).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Targets by name

  it("resolves a name target through the listing; unknown names run no pass", async () => {
    expect(await requestSync(ctx, { name: "handbook" }, webhook)).toMatchObject({
      status: "done",
      passes: 1,
      result: { status: "synced", repo: { githubId: HANDBOOK_ID } },
    });
    expect(await requestSync(ctx, { owner: "acme", name: "nope" }, webhook)).toMatchObject({
      status: "done",
      passes: 0,
      result: { status: "not_found" },
    });
    fake.fail({ path: LISTING, status: 404 });
    expect(await requestSync(ctx, { name: "handbook" }, webhook)).toMatchObject({
      status: "done",
      passes: 0,
      result: { status: "discovery_failed" },
    });
    await expect(requestSync(ctx, { githubId: 0 }, webhook)).rejects.toThrow(TypeError);
    await expect(requestSync(ctx, { githubId: 1 }, { ...webhook, maxPasses: 0 })).rejects.toThrow(
      TypeError,
    );
    await expect(
      requestSync(ctx, { githubId: 1 }, { ...webhook, queueWaitMs: -1 }),
    ).rejects.toThrow(TypeError);
  });

  it("an id that is not in the installation consumes its marker without a run", async () => {
    await initialSync();
    fake.removeRepo(HANDBOOK_ID);
    expect(await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook)).toMatchObject({
      status: "done",
      passes: 1,
      result: { status: "not_found" },
    });
    expect(await requested()).toEqual([]);
    // Not deleted on a single-repo not_found (it may be transient).
    expect(await repoRow(HANDBOOK_ID)).toBeDefined();
  });

  // -------------------------------------------------------------------------------------------
  // Full syncs

  it("a full sync that finds a repo busy records the request rather than losing it", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    const held = await withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, () =>
      syncAll(ctx, { trigger: "schedule" }),
    );
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    const entry = held.value.run.ran
      ? held.value.run.value.find((r) => r.githubId === HANDBOOK_ID)
      : undefined;
    expect(entry).toMatchObject({ status: "skipped", errorKind: "busy" });
    // The drain at the end tried again after marking: still held, so left to the holder.
    expect(held.value.drained).toEqual([{ githubId: HANDBOOK_ID, status: "coalesced", passes: 0 }]);
    expect(await requested()).toEqual([HANDBOOK_ID]);

    expect(await drainSyncRequests(ctx, { trigger: "schedule" })).toEqual([
      { githubId: HANDBOOK_ID, status: "done", passes: 1 },
    ]);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v2\n");
    expect(await requested()).toEqual([]);
  });

  it("a full sync clears the requests it covered and drains the ones that arrived during it", async () => {
    await initialSync();
    await markSyncRequested(h.db, METRICS_ID); // older than the run: covered by it
    const pause = pauseOnce(fake, HANDBOOK_BRANCH);
    const run = syncAll(ctx, { trigger: "schedule" });
    await pause.reached;
    // Metrics was synced first (listing order); a push for it arrives during the run.
    fake.setFile(METRICS_ID, "docs/m.md", "# M v2\n");
    expect(await requestSync(ctx, { githubId: METRICS_ID }, webhook)).toMatchObject({
      status: "done",
      passes: 1,
    });
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    expect(await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook)).toEqual({
      status: "coalesced",
      passes: 0,
    });
    pause.release();
    const result = await run;
    expect(result.drained).toEqual([{ githubId: HANDBOOK_ID, status: "done", passes: 1 }]);
    expect(await body(HANDBOOK_ID, "docs/a.md")).toBe("# A v2\n");
    expect(await body(METRICS_ID, "docs/m.md")).toBe("# M v2\n");
    expect(await requested()).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // The privatized race (task 6.3 handoff)

  it("privatized during a full sync that listed it public: the newer sync wins (row written after the listing)", async () => {
    await initialSync();
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("public");
    // The full sync lists both public, then works on metrics (listing order) and pauses there.
    const pause = pauseOnce(fake, METRICS_BRANCH);
    const run = syncAll(ctx, { trigger: "schedule" });
    await pause.reached;

    fake.updateRepo(HANDBOOK_ID, { visibility: "private" });
    expect(await markRepoPrivate(h.db, HANDBOOK_ID)).toBe(true);
    expect(await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook)).toMatchObject({
      status: "done",
      passes: 1,
    });
    pause.release();
    const result = await run;

    // The full sync's stale `public` listing is not written back.
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("private");
    const entry = result.run.ran
      ? result.run.value.find((r) => r.githubId === HANDBOOK_ID)
      : undefined;
    expect(entry).toMatchObject({
      status: "skipped",
      errorKind: "superseded",
      error: SUPERSEDED_MESSAGE,
    });
    expect(result.run.ran && result.run.status).toBe("success");
  });

  it("privatized while a sync with a public listing holds the repo: the marker forces a rerun", async () => {
    await initialSync();
    const pause = pauseOnce(fake, HANDBOOK_BRANCH);
    const run = syncAll(ctx, { trigger: "schedule" });
    await pause.reached; // holds handbook's lock with a `public` listing

    fake.updateRepo(HANDBOOK_ID, { visibility: "private" });
    expect(await markRepoPrivate(h.db, HANDBOOK_ID)).toBe(true);
    expect(await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook)).toEqual({
      status: "coalesced",
      passes: 0,
    });
    pause.release();
    const result = await run;
    expect(result.drained).toEqual([{ githubId: HANDBOOK_ID, status: "done", passes: 1 }]);
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("private");
    expect(await requested()).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Duplicate processing

  async function snapshot() {
    const repoRows = await h.db
      .select({
        githubId: repos.githubId,
        owner: repos.owner,
        name: repos.name,
        visibility: repos.visibility,
        treeSha: repos.treeSha,
        headEtag: repos.headEtag,
        commitSha: repos.commitSha,
        readmeSha: repos.readmeSha,
        docsPath: repos.docsPath,
        syncStatus: repos.syncStatus,
        syncError: repos.syncError,
        syncRequestedAt: repos.syncRequestedAt,
      })
      .from(repos)
      .orderBy(asc(repos.githubId));
    const docRows = await h.db
      .select({
        githubId: repos.githubId,
        path: documents.path,
        blobSha: documents.blobSha,
        title: documents.title,
        body: documents.body,
        frontmatter: documents.frontmatter,
        headings: documents.headings,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .orderBy(asc(repos.githubId), asc(documents.path));
    return { repoRows, docRows };
  }

  it("the same request processed twice in a row stores what processing it once stored", async () => {
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook);
    const once = await snapshot();
    const fetched = fake.requests.length;

    expect(await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook)).toMatchObject({
      status: "done",
      passes: 1,
      result: { result: { status: "unchanged" } },
    });
    expect(await snapshot()).toEqual(once);
    const again = fake.requests.slice(fetched);
    expect(again.filter((r) => HANDBOOK_TREES.test(r.path) || HANDBOOK_BLOBS.test(r.path))).toEqual(
      [],
    );
  });

  it("the same request processed twice at once stores what processing it once stored", async () => {
    // Processing once, for reference.
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    await requestSync(ctx, { githubId: HANDBOOK_ID }, webhook);
    const { docRows: onceDocs, repoRows: onceRepos } = await snapshot();

    // Same starting point again, then two at once.
    await h.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
    fake = new FakeGitHub({ owner: "acme", repos: [metrics(), handbook()] });
    ctx = contextFor(fake);
    await initialSync();
    fake.setFile(HANDBOOK_ID, "docs/a.md", "# A v2\n");
    const { meter, hooks } = passMeter();
    const results = await Promise.all([
      requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks }),
      requestSync(ctx, { githubId: HANDBOOK_ID }, { ...webhook, hooks }),
    ]);
    expect(meter.max).toBe(1);
    expect(results.map((r) => r.status).sort()).toContain("done");
    const twice = await snapshot();
    // Document timestamps differ between the two runs; everything else must match.
    const stable = <T extends { updatedAt: Date }>(rows: T[]) =>
      rows.map((row) => ({ ...row, updatedAt: null }));
    expect(twice.repoRows).toEqual(onceRepos);
    expect(stable(twice.docRows)).toEqual(stable(onceDocs));
    // At most the necessary fetches: the changed file once, one tree.
    expect(fake.requestsTo(HANDBOOK_BLOBS)).toHaveLength(1);
    expect(fake.requestsTo(HANDBOOK_TREES)).toHaveLength(1);
  });
});
