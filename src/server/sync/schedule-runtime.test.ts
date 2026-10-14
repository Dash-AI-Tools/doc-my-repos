import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/load";
import { configSchema } from "../config/schema";
import { withAdvisoryLock } from "../db/advisory-lock";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { recordingLogger } from "../test-logger";
import { createSyncContext, type SyncAllResult, type SyncContext } from "./engine";
import { FakeGitHub, type FakeRepoInit } from "./fake-github";
import { withRun } from "./runs";
import {
  SCHEDULED_SYNC_LOCK_KEY,
  bootSyncScheduler,
  fullRunOutcome,
  liveFullRun,
  runScheduledSync,
  schedulerMode,
  schedulerSettings,
  type SchedulerProcess,
  type SchedulerRuntime,
} from "./schedule-runtime";
import { DEFAULT_SCHEDULER_SETTINGS, type FullRunOutcome } from "./scheduler";

describe("schedulerMode", () => {
  it("is on in production, off elsewhere, unless SYNC_SCHEDULER says otherwise", () => {
    expect(schedulerMode({ NODE_ENV: "production" })).toEqual({
      enabled: true,
      reason: "production",
      invalidValue: false,
    });
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(schedulerMode({ NODE_ENV })).toMatchObject({
        enabled: false,
        reason: "not_production",
      });
    }
    for (const value of ["1", "true", " ON ", "yes"]) {
      expect(schedulerMode({ NODE_ENV: "development", SYNC_SCHEDULER: value })).toMatchObject({
        enabled: true,
        reason: "forced_on",
      });
    }
    for (const value of ["0", "false", "Off", "no"]) {
      expect(schedulerMode({ NODE_ENV: "production", SYNC_SCHEDULER: value })).toMatchObject({
        enabled: false,
        reason: "forced_off",
      });
    }
  });

  it("is off on e2e fixture servers unless forced on", () => {
    expect(schedulerMode({ NODE_ENV: "production", E2E_FIXTURES: "1" })).toMatchObject({
      enabled: false,
      reason: "e2e_fixtures",
    });
    expect(
      schedulerMode({ NODE_ENV: "production", E2E_FIXTURES: "1", SYNC_SCHEDULER: "1" }),
    ).toMatchObject({ enabled: true, reason: "forced_on" });
  });

  it("falls back to the default rule for an unknown value and flags it", () => {
    expect(schedulerMode({ NODE_ENV: "production", SYNC_SCHEDULER: "maybe" })).toEqual({
      enabled: true,
      reason: "production",
      invalidValue: true,
    });
    expect(schedulerMode({ SYNC_SCHEDULER: "  " })).toMatchObject({ invalidValue: false });
  });
});

describe("schedulerSettings", () => {
  it("takes interval and startup from the config and the rest from the defaults", () => {
    const sync = configSchema.parse({ sync: { intervalMinutes: 15, onStartup: false } }).sync;
    expect(schedulerSettings(sync)).toEqual({
      ...DEFAULT_SCHEDULER_SETTINGS,
      intervalMs: 15 * 60_000,
      onStartup: false,
    });
    expect(schedulerSettings(configSchema.parse({}).sync)).toMatchObject({
      intervalMs: 60 * 60_000,
      onStartup: true,
      startupDelayMs: 10_000,
      drainIntervalMs: 60_000,
      jitter: 0.1,
      maxBackoffMs: 15 * 60_000,
    });
    expect(schedulerSettings(undefined, { startupDelayMs: 5 })).toMatchObject({
      startupDelayMs: 5,
      intervalMs: 60 * 60_000,
    });
  });
});

describe("fullRunOutcome", () => {
  const base = { discovery: null, discoveredGithubIds: [], removals: [], drained: [] };
  const ran = (fatal: SyncAllResult["fatal"]): SyncAllResult => ({
    ...base,
    fatal,
    run: {
      ran: true,
      runId: 1,
      value: [],
      written: true,
      status: fatal ? "failed" : "success",
      stats: {} as never,
      durationMs: 1,
    },
  });
  const fatal = (kind: string, retryAt: number | null = null) => ({
    kind,
    message: "m",
    retryable: true,
    retryAt,
    fatal: true,
  });

  it("maps run results to scheduler outcomes", () => {
    expect(fullRunOutcome(ran(null), 0)).toEqual({ status: "ok" });
    expect(fullRunOutcome(ran(fatal("rate_limited", 5_000)), 1_000)).toEqual({
      status: "failed",
      kind: "rate_limited",
      retryAfterMs: 4_000,
    });
    expect(fullRunOutcome(ran(fatal("server")), 0)).toEqual({
      status: "failed",
      kind: "server",
      retryAfterMs: null,
    });
    expect(fullRunOutcome(ran(fatal("aborted")), 0)).toEqual({
      status: "skipped",
      reason: "aborted",
    });
    expect(
      fullRunOutcome(
        { ...base, fatal: null, run: { ran: false, runId: 1, reason: "lock_failed" } },
        0,
      ),
    ).toEqual({ status: "failed", kind: "lock_failed" });
  });
});

describe("bootSyncScheduler", () => {
  const runtime = (): SchedulerRuntime => ({
    loaded: { config: { sync: { intervalMinutes: 60, onStartup: true } } },
    sync: {} as SyncContext,
  });
  // Nothing fires during these tests.
  const quiet = { startupDelayMs: 3_600_000, drainIntervalMs: 0 };

  afterEach(async () => {
    // Stop whatever a test started so the per-process guard lets the next one boot.
    const started = bootSyncScheduler({
      getRuntime: runtime,
      env: { SYNC_SCHEDULER: "1" },
      process: null,
      log: recordingLogger().log,
      settings: quiet,
    });
    await started?.stop();
  });

  it("logs one line and starts nothing when disabled", () => {
    const rec = recordingLogger();
    const getRuntime = vi.fn(runtime);
    expect(
      bootSyncScheduler({
        getRuntime,
        env: { NODE_ENV: "development" },
        log: rec.log,
        process: null,
      }),
    ).toBeNull();
    expect(getRuntime).not.toHaveBeenCalled();
    expect(rec.records.map((r) => [r.event, r.reason])).toEqual([
      ["sync.scheduler.disabled", "not_production"],
    ]);
  });

  it("logs an invalid config once and does not throw", () => {
    const rec = recordingLogger();
    const getRuntime = vi.fn((): SchedulerRuntime => {
      throw new ConfigError([
        "GITHUB_APP_ID: is not set",
        "docmyrepos.config.yml: sync.x: unknown field",
      ]);
    });
    expect(
      bootSyncScheduler({
        getRuntime,
        env: { NODE_ENV: "production" },
        log: rec.log,
        process: null,
      }),
    ).toBeNull();
    expect(getRuntime).toHaveBeenCalledTimes(1);
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]).toMatchObject({
      level: "error",
      event: "sync.scheduler.config_invalid",
      problems: ["GITHUB_APP_ID: is not set", "docmyrepos.config.yml: sync.x: unknown field"],
    });
  });

  it("logs other boot errors without throwing", () => {
    const rec = recordingLogger();
    expect(
      bootSyncScheduler({
        getRuntime: () => {
          throw new Error("database url ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab");
        },
        env: { SYNC_SCHEDULER: "1" },
        log: rec.log,
        process: null,
      }),
    ).toBeNull();
    expect(rec.events()).toEqual(["sync.scheduler.config_invalid"]);
    expect(rec.lines.join("")).not.toContain("ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab");
  });

  it("starts once per process and logs its settings", async () => {
    const rec = recordingLogger();
    const options = {
      getRuntime: runtime,
      env: { NODE_ENV: "production", SYNC_SCHEDULER: "bogus" },
      log: rec.log,
      process: null,
      settings: quiet,
    };
    const first = bootSyncScheduler(options);
    expect(first?.active).toBe(true);
    expect(bootSyncScheduler(options)).toBe(first);
    expect(rec.records.map((r) => r.event)).toEqual([
      "sync.scheduler.invalid_setting",
      "sync.scheduler.started",
    ]);
    expect(rec.find("sync.scheduler.started")[0]).toMatchObject({
      reason: "production",
      onStartup: true,
      intervalMinutes: 60,
    });
    await first?.stop();
  });

  it("stops on SIGTERM and re-raises it when nobody else handles it", async () => {
    const listeners = new Map<string, (() => void)[]>();
    const kill = vi.fn();
    const proc: SchedulerProcess = {
      pid: 4242,
      once: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      removeListener: (event, fn) =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== fn),
        ),
      listenerCount: (event) => listeners.get(event)?.length ?? 0,
      kill,
    };
    const scheduler = bootSyncScheduler({
      getRuntime: runtime,
      env: { SYNC_SCHEDULER: "1" },
      log: recordingLogger().log,
      process: proc,
      settings: quiet,
    });
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("SIGINT")).toBe(1);
    // `once` semantics: the emitter drops the listener before calling it.
    const handler = listeners.get("SIGTERM")?.[0] as () => void;
    listeners.set("SIGTERM", []);
    handler();
    expect(scheduler?.active).toBe(false);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("leaves the exit to another SIGINT handler when there is one", () => {
    const listeners = new Map<string, (() => void)[]>([["SIGINT", [() => undefined]]]);
    const kill = vi.fn();
    const proc: SchedulerProcess = {
      pid: 1,
      once: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      removeListener: (event, fn) =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== fn),
        ),
      listenerCount: (event) => listeners.get(event)?.length ?? 0,
      kill,
    };
    const scheduler = bootSyncScheduler({
      getRuntime: runtime,
      env: { SYNC_SCHEDULER: "1" },
      log: recordingLogger().log,
      process: proc,
      settings: quiet,
    });
    const ours = listeners.get("SIGINT")?.[1] as () => void;
    listeners.set("SIGINT", [listeners.get("SIGINT")?.[0] as () => void]);
    ours();
    expect(scheduler?.active).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Against a real database

function repo(id: number, name: string): FakeRepoInit {
  return { id, name, files: { "docs/a.md": `# ${name}\n`, "docs/b.md": "# B\n" } };
}

describeDb("scheduled full syncs against a real database", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    h = createDb(testDb.url.reveal(), { max: 12 });
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
    return createSyncContext({
      db: h.db,
      pool: h.pool,
      github,
      config: configSchema.parse({}),
      log: recordingLogger().log,
    });
  }

  async function runs() {
    return h.db.select().from(syncRuns).orderBy(asc(syncRuns.id));
  }

  async function docPaths(): Promise<string[]> {
    const rows = await h.db
      .select({ name: repos.name, path: documents.path })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .orderBy(asc(repos.name), asc(documents.path));
    return rows.map((r) => `${r.name}:${r.path}`);
  }

  const EXPECTED = ["one:docs/a.md", "one:docs/b.md", "two:docs/a.md", "two:docs/b.md"];

  it("two schedulers ticking together produce one run; the other skips", async () => {
    const fake = new FakeGitHub({ repos: [repo(1, "one"), repo(2, "two")] });
    // Pause the first run at its listing so the second tick lands while it holds the lock.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atListing = new Promise<void>((resolve) => (reached = resolve));
    let paused = false;
    fake.onRequest = async (request) => {
      if (!paused && request.path === "/installation/repositories") {
        paused = true;
        reached();
        await released;
      }
    };
    const a = runScheduledSync(ctxFor(fake), "schedule");
    await atListing;
    const b: FullRunOutcome = await runScheduledSync(ctxFor(fake), "schedule");
    expect(b).toEqual({ status: "skipped", reason: "other_instance" });
    release();
    expect(await a).toEqual({ status: "ok" });
    expect((await runs()).map((r) => [r.trigger, r.status])).toEqual([["schedule", "success"]]);
    expect(await docPaths()).toEqual(EXPECTED);
  });

  it("skips while another full run is live, but not for a dead run's row", async () => {
    const fake = new FakeGitHub({ repos: [repo(1, "one")] });
    const ctx = ctxFor(fake);
    // A live manual full run (holds its run lock) while the scheduler ticks.
    const live = await withRun(h.db, h.pool, { trigger: "manual", scope: null }, async () => {
      expect(await liveFullRun(ctx)).toBe(true);
      return runScheduledSync(ctx, "schedule");
    });
    expect(live.ran && live.value).toEqual({ status: "skipped", reason: "run_in_progress" });

    // A row inserted a moment ago may belong to a run about to take its lock: live, unprobed.
    const [fresh] = await h.db
      .insert(syncRuns)
      .values({ trigger: "manual", scope: null })
      .returning({ id: syncRuns.id });
    expect(await liveFullRun(ctx)).toBe(true);
    await h.db
      .update(syncRuns)
      .set({ status: "failed" })
      .where(eq(syncRuns.id, fresh?.id ?? 0));

    // A `running` row left by a crashed process (older, no lock): the tick runs, and the reaper
    // fails the row once it is past its grace period.
    await h.db
      .insert(syncRuns)
      .values({ trigger: "schedule", scope: null, startedAt: sql`now() - interval '30 seconds'` });
    expect(await liveFullRun(ctx)).toBe(false);
    expect(await runScheduledSync(ctx, "startup")).toEqual({ status: "ok" });
  });

  it("concurrent full syncs without the scheduler lock still leave consistent data", async () => {
    const fake = new FakeGitHub({ repos: [repo(1, "one"), repo(2, "two")] });
    const { syncAll } = await import("./engine");
    const [x, y] = await Promise.all([
      syncAll(ctxFor(fake), { trigger: "manual" }),
      syncAll(ctxFor(fake), { trigger: "schedule" }),
    ]);
    expect(x.fatal).toBeNull();
    expect(y.fatal).toBeNull();
    // Per repo, one of the two synced it and the other found it busy or unchanged; afterwards
    // every document is there exactly once and both rows are ok.
    expect(await docPaths()).toEqual(EXPECTED);
    const rows = await h.db.select({ s: repos.syncStatus, t: repos.treeSha }).from(repos);
    expect(rows.every((r) => r.s === "ok" && r.t !== null)).toBe(true);
    expect((await runs()).every((r) => r.status === "success")).toBe(true);
  });

  it("an aborted scheduled run reports skipped and keeps stored content", async () => {
    const fake = new FakeGitHub({ repos: [repo(1, "one")] });
    const ctx = ctxFor(fake);
    expect(await runScheduledSync(ctx, "startup")).toEqual({ status: "ok" });
    const controller = new AbortController();
    controller.abort();
    expect(await runScheduledSync(ctx, "schedule", controller.signal)).toEqual({
      status: "skipped",
      reason: "aborted",
    });
    expect(await docPaths()).toEqual(["one:docs/a.md", "one:docs/b.md"]);
  });

  it("the scheduled-sync lock is free again after a run", async () => {
    const fake = new FakeGitHub({ repos: [repo(1, "one")] });
    await runScheduledSync(ctxFor(fake), "schedule");
    const probe = await withAdvisoryLock(h.pool, SCHEDULED_SYNC_LOCK_KEY, async () => "free");
    expect(probe).toEqual({ acquired: true, value: "free" });
  });

  it("boots, runs the startup sync, and stops cleanly", async () => {
    const fake = new FakeGitHub({ repos: [repo(1, "one"), repo(2, "two")] });
    const ctx = ctxFor(fake);
    const rec = recordingLogger();
    const scheduler = bootSyncScheduler({
      getRuntime: () => ({ loaded: { config: configSchema.parse({}) }, sync: ctx }),
      env: { SYNC_SCHEDULER: "1" },
      log: rec.log,
      process: null,
      settings: { startupDelayMs: 0, drainIntervalMs: 0 },
    });
    expect(scheduler).not.toBeNull();
    await vi.waitFor(
      async () => {
        const all = await runs();
        expect(all.map((r) => [r.trigger, r.status])).toEqual([["startup", "success"]]);
      },
      { timeout: 20_000, interval: 50 },
    );
    await scheduler?.stop();
    expect(await docPaths()).toEqual(EXPECTED);
    expect(rec.events()).toContain("sync.scheduler.started");
    expect(rec.events()).toContain("sync.schedule.run");
  });
});
