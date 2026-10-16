import { and, eq, isNull, sql } from "drizzle-orm";

import type { EnvSource } from "../config/env";
import { advisoryLockKey, withAdvisoryLock } from "../db/advisory-lock";
import { syncRuns } from "../db/schema";
import { errorFields, logger as processLogger, type Logger } from "../log";
import { drainSyncRequests, syncAll, type SyncAllResult, type SyncContext } from "./engine";
import { reapStaleRuns, syncRunLockKey } from "./runs";
import {
  DEFAULT_SCHEDULER_SETTINGS,
  startScheduler,
  type FullRunOutcome,
  type Scheduler,
  type SchedulerSettings,
  type SchedulerTimers,
  type ScheduledTrigger,
} from "./scheduler";

/**
 * Wires the pure scheduler (`scheduler.ts`) to the sync engine and the server process. Started
 * from `src/instrumentation.ts` (Next.js `register()`, Node.js runtime only) through
 * `bootSyncScheduler`.
 *
 * - Whether it runs: `schedulerMode` (environment only). `SYNC_SCHEDULER=1|true|on` forces it on,
 *   `0|false|off` off. Unset: on when `NODE_ENV=production`, off otherwise (so `pnpm dev` and the
 *   tests never call GitHub on their own), and off on e2e fixture servers (`E2E_FIXTURES=1`). The
 *   e2e database servers set `SYNC_SCHEDULER=0`. An unknown value falls back to the default rule
 *   and is logged.
 * - What it runs: settings from the config's `sync` block (`intervalMinutes`, `onStartup`) read
 *   once at boot (a change needs a restart); the work itself uses the CURRENT runtime on every tick,
 *   so a config reload through `/api/sync` applies to the repos it narrows.
 * - Several instances: a full run is taken under one cluster-wide advisory lock
 *   (`SCHEDULED_SYNC_LOCK_NAMESPACE`) in try mode, so of several schedulers ticking together one
 *   runs and the others skip (`other_instance`); a full run already live (manual `/api/sync` or
 *   another instance's, detected by its run lock) also makes the tick skip (`run_in_progress`).
 *   Without either guard the repo locks would still serialize every repo (no corruption), only
 *   with duplicate work and `busy` entries.
 */

export const SYNC_SCHEDULER_VAR = "SYNC_SCHEDULER";

export type SchedulerModeReason =
  "forced_on" | "forced_off" | "production" | "not_production" | "e2e_fixtures";

export interface SchedulerMode {
  enabled: boolean;
  reason: SchedulerModeReason;
  /** `SYNC_SCHEDULER` was set to something unknown; the default rule decided. */
  invalidValue: boolean;
}

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["0", "false", "off", "no"]);

/** Whether the background scheduler runs in this process (see the module comment). Pure. */
export function schedulerMode(env: EnvSource): SchedulerMode {
  const raw = (env[SYNC_SCHEDULER_VAR] ?? "").trim().toLowerCase();
  if (ON.has(raw)) return { enabled: true, reason: "forced_on", invalidValue: false };
  if (OFF.has(raw)) return { enabled: false, reason: "forced_off", invalidValue: false };
  const invalidValue = raw !== "";
  if ((env.E2E_FIXTURES ?? "").trim() === "1") {
    return { enabled: false, reason: "e2e_fixtures", invalidValue };
  }
  return env.NODE_ENV === "production"
    ? { enabled: true, reason: "production", invalidValue }
    : { enabled: false, reason: "not_production", invalidValue };
}

/** The config's `sync` block (`config/schema.ts`), as the scheduler reads it. */
export interface SyncScheduleConfig {
  readonly intervalMinutes: number;
  readonly onStartup: boolean;
}

/** Scheduler settings from the config's `sync` block; the rest are the code defaults. */
export function schedulerSettings(
  sync: SyncScheduleConfig | undefined,
  overrides: Partial<SchedulerSettings> = {},
): SchedulerSettings {
  return {
    ...DEFAULT_SCHEDULER_SETTINGS,
    ...(sync === undefined
      ? {}
      : { onStartup: sync.onStartup, intervalMs: sync.intervalMinutes * 60_000 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// The work

/** Advisory-lock namespace of the cluster-wide "one scheduled full sync at a time" lock. */
export const SCHEDULED_SYNC_LOCK_NAMESPACE = "docmyrepos:scheduled-sync";
export const SCHEDULED_SYNC_LOCK_KEY = advisoryLockKey(SCHEDULED_SYNC_LOCK_NAMESPACE, "full");

/**
 * A run inserts its `running` row a moment before it takes its run lock; a row younger than this
 * counts as live without probing, so the probe never takes the lock from under a starting run
 * (which would fail it with a lock error).
 */
export const FRESH_RUN_MS = 5_000;

/**
 * Whether a full run (scope null) is live right now: a `running` row whose run lock is held, or
 * one started less than `FRESH_RUN_MS` ago. A row left by a dead process holds no lock and does
 * not count once it is older than that (the reaper fails it later). The startup tick comes
 * 10 s after boot, so a row left by the crash before a restart is already probed by then.
 */
export async function liveFullRun(ctx: Pick<SyncContext, "db" | "pool">): Promise<boolean> {
  const rows = await ctx.db
    .select({
      id: syncRuns.id,
      fresh: sql<boolean>`${syncRuns.startedAt} > now() - make_interval(secs => ${FRESH_RUN_MS / 1000})`,
    })
    .from(syncRuns)
    .where(and(eq(syncRuns.status, "running"), isNull(syncRuns.scope)));
  if (rows.some((r) => r.fresh)) return true;
  for (const { id } of rows) {
    const probe = await withAdvisoryLock(ctx.pool, syncRunLockKey(id), async () => undefined);
    if (!probe.acquired && probe.reason === "busy") return true;
  }
  return false;
}

/** The scheduler's view of a finished `syncAll`. */
export function fullRunOutcome(result: SyncAllResult, now: number): FullRunOutcome {
  if (!result.run.ran) return { status: "failed", kind: result.run.reason };
  const fatal = result.fatal;
  if (fatal === null) return { status: "ok" };
  if (fatal.kind === "aborted") return { status: "skipped", reason: "aborted" };
  return {
    status: "failed",
    kind: fatal.kind,
    retryAfterMs: fatal.retryAt === null ? null : Math.max(0, fatal.retryAt - now),
  };
}

/**
 * One scheduled full sync: under the cluster-wide scheduled-sync lock (try mode: another
 * instance's scheduled run means `skipped`), reaps stale runs, skips when a full run is already
 * live, else runs `syncAll` (which lists, syncs, confirms and executes removals, then drains
 * waiting requests).
 */
export async function runScheduledSync(
  ctx: SyncContext,
  trigger: ScheduledTrigger,
  signal?: AbortSignal,
): Promise<FullRunOutcome> {
  const lock = await withAdvisoryLock(
    ctx.pool,
    SCHEDULED_SYNC_LOCK_KEY,
    async ({ signal: held }): Promise<FullRunOutcome> => {
      await reapStaleRuns(ctx.db, ctx.pool, { log: ctx.log });
      if (await liveFullRun(ctx)) return { status: "skipped", reason: "run_in_progress" };
      const result = await syncAll(ctx, { trigger, signal: held });
      return fullRunOutcome(result, ctx.now());
    },
    { signal },
  );
  if (lock.acquired) return lock.value;
  return { status: "skipped", reason: lock.reason === "busy" ? "other_instance" : lock.reason };
}

// ---------------------------------------------------------------------------------------------
// Boot

/**
 * What the boot needs from the workspace (`src/server/workspace.ts` `getWorkspace` fits): the
 * schedule settings, and the sync context once the GitHub settings are complete (null before).
 */
export interface SchedulerRuntime {
  readonly config: { readonly sync?: SyncScheduleConfig };
  readonly github: { readonly sync: SyncContext } | null;
}

type SignalName = "SIGTERM" | "SIGINT";

/** The parts of `process` the boot uses for shutdown handling. */
export interface SchedulerProcess {
  once(event: SignalName, listener: () => void): unknown;
  removeListener(event: SignalName, listener: () => void): unknown;
  listenerCount(event: SignalName): number;
  kill(pid: number, signal: SignalName): unknown;
  readonly pid: number;
}

export interface BootOptions {
  /** Returns the current workspace; called at boot and on every tick. */
  getRuntime: () => Promise<SchedulerRuntime>;
  /** Default `process.env`. */
  env?: EnvSource;
  /** Default: the process logger. */
  log?: Logger;
  /** Default `process`. null: no SIGTERM/SIGINT handling (tests). */
  process?: SchedulerProcess | null;
  timers?: SchedulerTimers;
  random?: () => number;
  /** Test hook: settings that are not in the config (startup delay, drain period, ...). */
  settings?: Partial<SchedulerSettings>;
}

const BOOT_KEY = Symbol.for("docmyrepos.syncScheduler");
type BootCache = { [BOOT_KEY]?: Scheduler };

/**
 * Starts the background scheduler once per process, or explains why not in ONE structured line:
 * `sync.scheduler.disabled` (with the reason), `sync.scheduler.settings_unreadable` (the settings
 * could not be loaded: logged once, the server keeps serving, nothing is retried until a restart),
 * or `sync.scheduler.started` (with the settings). Never throws. Returns the running scheduler or
 * null. A second call returns the first scheduler (Next.js dev reloads).
 *
 * The schedule itself (interval, run on startup) is read when the server starts, so a changed
 * schedule applies after a restart. Everything a run uses (repositories, limits, credentials) is
 * read from the current workspace on each tick, and a tick with incomplete GitHub settings is
 * skipped, so the scheduler can start before an administrator has configured GitHub.
 *
 * On SIGTERM/SIGINT the scheduler stops (timers cleared, the run in progress aborted; its run row
 * is finished as aborted, or reaped later). When no other listener handles the signal, it is
 * re-raised so the process still exits the default way.
 */
export async function bootSyncScheduler(options: BootOptions): Promise<Scheduler | null> {
  const log = options.log ?? processLogger;
  const cache = globalThis as BootCache;
  const existing = cache[BOOT_KEY];
  if (existing !== undefined && existing.active) return existing;
  try {
    return await boot(options, log, cache);
  } catch (error) {
    log.error("sync.scheduler.boot_failed", errorFields(error));
    return null;
  }
}

async function boot(
  options: BootOptions,
  log: Logger,
  cache: BootCache,
): Promise<Scheduler | null> {
  const mode = schedulerMode(options.env ?? process.env);
  if (mode.invalidValue) {
    log.warn("sync.scheduler.invalid_setting", { variable: SYNC_SCHEDULER_VAR });
  }
  if (!mode.enabled) {
    log.info("sync.scheduler.disabled", { reason: mode.reason });
    return null;
  }

  let runtime: SchedulerRuntime;
  try {
    runtime = await options.getRuntime();
  } catch (error) {
    log.error("sync.scheduler.settings_unreadable", errorFields(error));
    return null;
  }

  const settings = schedulerSettings(runtime.config.sync, options.settings);
  // Each tick reads the current workspace; without complete GitHub settings it does nothing.
  const current = async (): Promise<SyncContext | null> =>
    (await options.getRuntime()).github?.sync ?? null;
  const scheduler = startScheduler(settings, {
    runFull: async (trigger, signal): Promise<FullRunOutcome> => {
      const ctx = await current();
      return ctx === null
        ? { status: "skipped", reason: "not_configured" }
        : runScheduledSync(ctx, trigger, signal);
    },
    drain: async (signal) => {
      const ctx = await current();
      if (ctx !== null) await drainSyncRequests(ctx, { trigger: "schedule", signal });
    },
    reap: async () => {
      const ctx = await current();
      if (ctx !== null) await reapStaleRuns(ctx.db, ctx.pool, { log: ctx.log });
    },
    timers: options.timers,
    random: options.random,
    log,
  });
  cache[BOOT_KEY] = scheduler;
  log.info("sync.scheduler.started", {
    reason: mode.reason,
    onStartup: settings.onStartup,
    intervalMinutes: settings.intervalMs / 60_000,
    startupDelayMs: settings.startupDelayMs,
    drainIntervalMs: settings.drainIntervalMs,
  });

  const proc = options.process === undefined ? process : options.process;
  if (proc !== null) {
    const signals: SignalName[] = ["SIGTERM", "SIGINT"];
    const handlers = new Map<SignalName, () => void>();
    for (const name of signals) {
      const handler = () => {
        for (const [other, h] of handlers) proc.removeListener(other, h);
        void scheduler.stop();
        // Nobody else handles it (no framework handler): restore the default exit.
        if (proc.listenerCount(name) === 0) proc.kill(proc.pid, name);
      };
      handlers.set(name, handler);
      proc.once(name, handler);
    }
  }
  return scheduler;
}
