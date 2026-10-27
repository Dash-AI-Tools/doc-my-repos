import { errorFields, logger as processLogger, type Logger } from "../log";

/**
 * The background sync scheduler's core (design: "Keep content fresh via webhooks, with a
 * manual/scheduled fallback"; risk "Webhook delivery lost -> scheduled/manual full sync").
 *
 * Pure and injectable: the work (`runFull`, `drain`, `reap`), the timers and the random source
 * are passed in, and nothing here imports Next.js, the database or GitHub. `schedule-runtime.ts`
 * wires it to the sync engine, and `src/instrumentation.ts` starts it in the server process.
 *
 * What it does once started:
 *
 * - Startup: after `startupDelayMs` it reaps stale runs (`reap`), then, when `onStartup` is set,
 *   runs one full sync with trigger `startup`.
 * - Periodic full sync every `intervalMs` (0: none), trigger `schedule`. Each delay is jittered by
 *   +-`jitter` (a fraction) so several instances started together drift apart. The next run is
 *   timed from the end of the previous one, so full runs never overlap.
 * - Failure backoff: a failed full run (an outcome `failed` or a thrown error) never stops the
 *   loop. The next attempt comes after `retryBaseMs`, doubling per consecutive failure, capped at
 *   `maxBackoffMs` and never later than the normal interval; a rate limit's `retryAfterMs` pushes it
 *   later (up to the longer of the interval and the cap). With periodic runs off, a failed startup
 *   run is retried this way until one succeeds. A success or a skip resets the count.
 * - Drain tick every `drainIntervalMs` (0: none): runs waiting per-repo sync requests (rerun
 *   markers left by busy repos, fatal runs or a crashed process). Bounded by `drainTimeoutMs`.
 * - No overlap inside one process: a drain tick that finds a full run (or another drain) in
 *   progress is skipped; a full run that finds a drain in progress waits for it to settle first.
 *   Across processes the runner's own locks decide (see `schedule-runtime.ts`).
 * - `stop()` clears every timer, aborts the work in progress through its signal, and resolves when
 *   that work has settled. Timers are `unref`'d by the default timer source, so the scheduler never
 *   keeps the process alive.
 */

export type ScheduledTrigger = "startup" | "schedule";

/** What one full run reported to the scheduler. */
export type FullRunOutcome =
  | { status: "ok" }
  /** Not run, and not a failure: another instance or run had it covered. */
  | { status: "skipped"; reason: string }
  /** The run failed (listing failed, fatal error, lock problem). */
  | { status: "failed"; kind?: string; retryAfterMs?: number | null };

export interface SchedulerSettings {
  /** Run one full sync after startup. */
  onStartup: boolean;
  /** Delay before the startup work (reap, then the startup run). */
  startupDelayMs: number;
  /** Period of full syncs; 0 disables periodic runs. */
  intervalMs: number;
  /** Period of drain ticks; 0 disables them. */
  drainIntervalMs: number;
  /** Upper bound of one drain tick; its signal aborts after this long. */
  drainTimeoutMs: number;
  /** Relative jitter applied to every delay, in [0, 0.5]. 0.1 means +-10 %. */
  jitter: number;
  /** First retry delay after a failed full run. */
  retryBaseMs: number;
  /** Cap of the failure backoff. */
  maxBackoffMs: number;
}

export const DEFAULT_STARTUP_DELAY_MS = 10_000;
export const DEFAULT_DRAIN_INTERVAL_MS = 60_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_JITTER = 0.1;
export const DEFAULT_RETRY_BASE_MS = 60_000;
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

export const DEFAULT_SCHEDULER_SETTINGS: Readonly<SchedulerSettings> = Object.freeze({
  onStartup: true,
  startupDelayMs: DEFAULT_STARTUP_DELAY_MS,
  intervalMs: 60 * 60_000,
  drainIntervalMs: DEFAULT_DRAIN_INTERVAL_MS,
  drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
  jitter: DEFAULT_JITTER,
  retryBaseMs: DEFAULT_RETRY_BASE_MS,
  maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
});

/** A timer source. The default wraps the global timers and `unref`s every timer. */
export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const unrefTimers: SchedulerTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface SchedulerDeps {
  /** One full sync. May throw: counted as a failure. */
  runFull(trigger: ScheduledTrigger, signal: AbortSignal): Promise<FullRunOutcome>;
  /** Runs waiting per-repo sync requests. May throw: logged, the loop goes on. */
  drain(signal: AbortSignal): Promise<void>;
  /** Fails runs a dead process left `running`. May throw: logged. */
  reap(signal: AbortSignal): Promise<void>;
  /** Default `unrefTimers`. */
  timers?: SchedulerTimers;
  /** `Math.random`-like source for jitter. */
  random?: () => number;
  /** Default: the process logger. */
  log?: Logger;
}

export interface Scheduler {
  /** Clears timers, aborts the work in progress, and resolves once it has settled. Idempotent. */
  stop(): Promise<void>;
  /** True until `stop()` is called. */
  readonly active: boolean;
  /** Whether a full run or drain is in progress. */
  readonly busy: boolean;
  /** Consecutive failed full runs (for tests and status). */
  readonly failures: number;
}

function checkSettings(s: SchedulerSettings): void {
  const nonNegative = (value: number, name: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a finite number >= 0`);
    }
  };
  nonNegative(s.startupDelayMs, "startupDelayMs");
  nonNegative(s.intervalMs, "intervalMs");
  nonNegative(s.drainIntervalMs, "drainIntervalMs");
  nonNegative(s.drainTimeoutMs, "drainTimeoutMs");
  nonNegative(s.retryBaseMs, "retryBaseMs");
  nonNegative(s.maxBackoffMs, "maxBackoffMs");
  if (typeof s.jitter !== "number" || !(s.jitter >= 0 && s.jitter <= 0.5)) {
    throw new TypeError("jitter must be a number in [0, 0.5]");
  }
  if (typeof s.onStartup !== "boolean") throw new TypeError("onStartup must be a boolean");
}

/** `ms` scaled by a factor in [1 - jitter, 1 + jitter]. Exported for tests. */
export function jittered(ms: number, jitter: number, random: () => number): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.max(0, Math.round(ms * (1 + jitter * (2 * r - 1))));
}

/**
 * The delay before the next full run after `failures` consecutive failures (>= 1), before jitter.
 * Exported for tests.
 */
export function failureDelayMs(
  settings: Pick<SchedulerSettings, "intervalMs" | "retryBaseMs" | "maxBackoffMs">,
  failures: number,
  retryAfterMs?: number | null,
): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  let delay = Math.min(settings.retryBaseMs * 2 ** exponent, settings.maxBackoffMs);
  if (settings.intervalMs > 0) delay = Math.min(delay, settings.intervalMs);
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > delay) {
    delay = Math.min(retryAfterMs, Math.max(settings.intervalMs, settings.maxBackoffMs));
  }
  return delay;
}

/** Starts the scheduler. Validates the settings (TypeError) before any timer is set. */
export function startScheduler(settings: SchedulerSettings, deps: SchedulerDeps): Scheduler {
  checkSettings(settings);
  const timers = deps.timers ?? unrefTimers;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? processLogger;
  const stopping = new AbortController();

  let active = true;
  let failures = 0;
  /** The full run or drain in progress, if any. Never rejects. */
  let current: Promise<void> | null = null;
  let fullTimer: unknown;
  let drainTimer: unknown;

  /** Runs `work` as the current activity; resolves when it settled. */
  function occupy(work: () => Promise<void>): Promise<void> {
    const task = work().finally(() => {
      if (current === task) current = null;
    });
    current = task;
    return task;
  }

  function scheduleFull(delayMs: number, trigger: ScheduledTrigger): void {
    if (!active) return;
    log.debug("sync.schedule.next", { trigger, inMs: delayMs, failures });
    fullTimer = timers.setTimeout(() => {
      fullTimer = undefined;
      void fullTick(trigger);
    }, delayMs);
  }

  function scheduleDrain(): void {
    if (!active || settings.drainIntervalMs <= 0) return;
    drainTimer = timers.setTimeout(
      () => {
        drainTimer = undefined;
        void drainTick();
      },
      jittered(settings.drainIntervalMs, settings.jitter, random),
    );
  }

  /** After a full run (or the startup step without one): time the next full run. */
  function afterFull(outcome: FullRunOutcome | null): void {
    if (outcome !== null && outcome.status === "failed") {
      failures += 1;
      const base = failureDelayMs(settings, failures, outcome.retryAfterMs);
      scheduleFull(jittered(base, settings.jitter, random), "schedule");
      return;
    }
    if (outcome !== null) failures = 0;
    if (settings.intervalMs > 0) {
      scheduleFull(jittered(settings.intervalMs, settings.jitter, random), "schedule");
    }
  }

  async function runFullOnce(trigger: ScheduledTrigger): Promise<FullRunOutcome> {
    log.info("sync.schedule.run", { trigger });
    try {
      const outcome = await deps.runFull(trigger, stopping.signal);
      if (outcome.status === "skipped") {
        log.info("sync.schedule.skipped", { trigger, reason: outcome.reason });
      } else if (outcome.status === "failed") {
        log.warn("sync.schedule.failed", {
          trigger,
          kind: outcome.kind ?? null,
          failures: failures + 1,
        });
      }
      return outcome;
    } catch (error) {
      log.error("sync.schedule.failed", { trigger, failures: failures + 1, ...errorFields(error) });
      return { status: "failed" };
    }
  }

  async function fullTick(trigger: ScheduledTrigger): Promise<void> {
    // A drain in progress: wait for it, then run (full runs are never dropped for a drain).
    while (current !== null && active) await current;
    if (!active) return;
    let outcome: FullRunOutcome | null = null;
    await occupy(async () => {
      outcome = await runFullOnce(trigger);
    });
    if (!active) return;
    afterFull(outcome);
  }

  async function startupTick(): Promise<void> {
    while (current !== null && active) await current;
    if (!active) return;
    let outcome: FullRunOutcome | null = null;
    await occupy(async () => {
      try {
        await deps.reap(stopping.signal);
      } catch (error) {
        log.warn("sync.schedule.reap_failed", errorFields(error));
      }
      if (settings.onStartup && active) outcome = await runFullOnce("startup");
    });
    if (!active) return;
    afterFull(outcome);
  }

  async function drainTick(): Promise<void> {
    if (!active) return;
    if (current !== null) {
      log.debug("sync.schedule.skipped", { trigger: "drain", reason: "busy" });
      scheduleDrain();
      return;
    }
    await occupy(async () => {
      // The bound runs on the injected timers, so a fake clock drives it in tests.
      const timeout = new AbortController();
      const handle = timers.setTimeout(() => timeout.abort(), settings.drainTimeoutMs);
      try {
        await deps.drain(AbortSignal.any([stopping.signal, timeout.signal]));
      } catch (error) {
        log.warn("sync.schedule.drain_failed", errorFields(error));
      } finally {
        timers.clearTimeout(handle);
      }
    });
    scheduleDrain();
  }

  fullTimer = timers.setTimeout(() => {
    fullTimer = undefined;
    void startupTick();
  }, settings.startupDelayMs);
  scheduleDrain();

  return {
    async stop() {
      if (active) {
        active = false;
        if (fullTimer !== undefined) timers.clearTimeout(fullTimer);
        if (drainTimer !== undefined) timers.clearTimeout(drainTimer);
        fullTimer = undefined;
        drainTimer = undefined;
        stopping.abort();
        log.info("sync.scheduler.stopped", { busy: current !== null });
      }
      while (current !== null) await current;
    },
    get active() {
      return active;
    },
    get busy() {
      return current !== null;
    },
    get failures() {
      return failures;
    },
  };
}
