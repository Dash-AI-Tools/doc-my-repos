import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordingLogger } from "../test-logger";
import {
  DEFAULT_SCHEDULER_SETTINGS,
  failureDelayMs,
  jittered,
  startScheduler,
  unrefTimers,
  type FullRunOutcome,
  type Scheduler,
  type SchedulerDeps,
  type SchedulerSettings,
  type ScheduledTrigger,
} from "./scheduler";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A run whose completion the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  scheduler: Scheduler;
  /** [ms since start, what] for every call. */
  calls: [number, string][];
  signals: AbortSignal[];
  log: ReturnType<typeof recordingLogger>;
}

const START = Date.UTC(2026, 0, 1);

function start(
  settings: Partial<SchedulerSettings> = {},
  deps: Partial<SchedulerDeps> = {},
): Harness {
  const calls: [number, string][] = [];
  const signals: AbortSignal[] = [];
  const log = recordingLogger();
  const at = () => Date.now() - START;
  const scheduler = startScheduler(
    { ...DEFAULT_SCHEDULER_SETTINGS, drainIntervalMs: 0, ...settings },
    {
      random: () => 0.5,
      log: log.log,
      reap: async () => {
        calls.push([at(), "reap"]);
      },
      drain: async (signal) => {
        calls.push([at(), "drain"]);
        signals.push(signal);
      },
      runFull: async (trigger: ScheduledTrigger, signal) => {
        calls.push([at(), `full:${trigger}`]);
        signals.push(signal);
        return { status: "ok" };
      },
      ...wrap(deps, calls, signals, at),
    },
  );
  return { scheduler, calls, signals, log };
}

/** Records calls of overridden deps too. */
function wrap(
  deps: Partial<SchedulerDeps>,
  calls: [number, string][],
  signals: AbortSignal[],
  at: () => number,
): Partial<SchedulerDeps> {
  const out: Partial<SchedulerDeps> = { ...deps };
  if (deps.runFull) {
    const inner = deps.runFull;
    out.runFull = (trigger, signal) => {
      calls.push([at(), `full:${trigger}`]);
      signals.push(signal);
      return inner(trigger, signal);
    };
  }
  if (deps.drain) {
    const inner = deps.drain;
    out.drain = (signal) => {
      calls.push([at(), "drain"]);
      signals.push(signal);
      return inner(signal);
    };
  }
  return out;
}

describe("scheduler core", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the startup delay, reaps, then runs the startup sync", async () => {
    const h = start({ startupDelayMs: 10 * SECOND, intervalMs: 0 });
    await vi.advanceTimersByTimeAsync(10 * SECOND - 1);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([
      [10 * SECOND, "reap"],
      [10 * SECOND, "full:startup"],
    ]);
    // Periodic runs off: nothing more.
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(h.calls).toHaveLength(2);
    await h.scheduler.stop();
  });

  it("runs periodic full syncs timed from the end of the previous one", async () => {
    const run = deferred<FullRunOutcome>();
    let first = true;
    const h = start(
      { startupDelayMs: 0, intervalMs: 60 * MINUTE },
      {
        runFull: async () => {
          if (!first) return { status: "ok" };
          first = false;
          return run.promise;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.map((c) => c[1])).toEqual(["reap", "full:startup"]);
    // The startup run takes 5 minutes.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    run.resolve({ status: "ok" });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(h.calls.slice(2)).toEqual([[65 * MINUTE, "full:schedule"]]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(h.calls.slice(3)).toEqual([[125 * MINUTE, "full:schedule"]]);
    await h.scheduler.stop();
  });

  it("without onStartup only reaps at startup; the first full run comes one interval later", async () => {
    const h = start({ onStartup: false, startupDelayMs: 10 * SECOND, intervalMs: 30 * MINUTE });
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(h.calls).toEqual([[10 * SECOND, "reap"]]);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(h.calls.slice(1)).toEqual([[10 * SECOND + 30 * MINUTE, "full:schedule"]]);
    await h.scheduler.stop();
  });

  it("jitters every delay within +-10 %", () => {
    expect(jittered(60 * MINUTE, 0.1, () => 0)).toBe(54 * MINUTE);
    expect(jittered(60 * MINUTE, 0.1, () => 1)).toBe(66 * MINUTE);
    expect(jittered(60 * MINUTE, 0.1, () => 0.5)).toBe(60 * MINUTE);
    expect(jittered(60 * MINUTE, 0, () => 0)).toBe(60 * MINUTE);
    for (let i = 0; i < 200; i++) {
      const d = jittered(60 * MINUTE, 0.1, Math.random);
      expect(d).toBeGreaterThanOrEqual(54 * MINUTE);
      expect(d).toBeLessThanOrEqual(66 * MINUTE);
    }
    // Out-of-range random values are clamped.
    expect(jittered(1000, 0.1, () => 7)).toBe(1100);
    expect(jittered(1000, 0.1, () => -3)).toBe(900);
  });

  it("applies the jitter to the periodic delay", async () => {
    for (const [random, expected] of [
      [0, 54 * MINUTE],
      [1, 66 * MINUTE],
    ] as const) {
      const calls: number[] = [];
      const s = startScheduler(
        { ...DEFAULT_SCHEDULER_SETTINGS, startupDelayMs: 0, drainIntervalMs: 0 },
        {
          random: () => random,
          log: recordingLogger().log,
          reap: async () => undefined,
          drain: async () => undefined,
          runFull: async () => {
            calls.push(Date.now() - START);
            return { status: "ok" };
          },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await s.stop();
      vi.setSystemTime(START);
    }
  });

  it("never overlaps: a drain tick during a full run is skipped", async () => {
    const run = deferred<FullRunOutcome>();
    const h = start(
      { startupDelayMs: 0, intervalMs: 60 * MINUTE, drainIntervalMs: MINUTE },
      { runFull: () => run.promise },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.busy).toBe(true);
    // Three drain ticks pass while the startup run is still going.
    await vi.advanceTimersByTimeAsync(3 * MINUTE + SECOND);
    expect(h.calls.map((c) => c[1])).toEqual(["reap", "full:startup"]);
    expect(h.log.find("sync.schedule.skipped").map((r) => r.reason)).toEqual([
      "busy",
      "busy",
      "busy",
    ]);
    run.resolve({ status: "ok" });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.calls.map((c) => c[1])).toContain("drain");
    await h.scheduler.stop();
  });

  it("a full tick waits for a drain in progress instead of running beside it", async () => {
    const drain = deferred<void>();
    const h = start(
      { onStartup: false, startupDelayMs: 0, intervalMs: 5 * MINUTE, drainIntervalMs: MINUTE },
      { drain: () => drain.promise },
    );
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.calls.map((c) => c[1])).toEqual(["reap", "drain"]);
    // The full run is due at 5 min, the drain is still running at 6 min.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(h.calls.map((c) => c[1])).toEqual(["reap", "drain"]);
    drain.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.map((c) => c[1])).toEqual(["reap", "drain", "full:schedule"]);
    expect(h.calls[2]?.[0]).toBe(6 * MINUTE);
    await h.scheduler.stop();
  });

  it("keeps going after failures, backing off exponentially up to the cap", async () => {
    let fail = true;
    const h = start(
      { startupDelayMs: 0, intervalMs: 60 * MINUTE },
      {
        runFull: async () => {
          if (fail) throw new Error("boom");
          return { status: "ok" };
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    // 1, 2, 4, 8 minutes, then capped at 15.
    await vi.advanceTimersByTimeAsync((1 + 2 + 4 + 8 + 15 + 15) * MINUTE);
    const times = h.calls.filter((c) => c[1].startsWith("full")).map((c) => c[0] / MINUTE);
    expect(times).toEqual([0, 1, 3, 7, 15, 30, 45]);
    expect(h.scheduler.failures).toBe(7);
    expect(h.log.find("sync.schedule.failed")).toHaveLength(7);
    expect(h.log.find("sync.schedule.failed")[0]).toMatchObject({ level: "error" });

    // A success resets the count and the normal interval resumes.
    fail = false;
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(h.scheduler.failures).toBe(0);
    const before = h.calls.length;
    await vi.advanceTimersByTimeAsync(60 * MINUTE - 1);
    expect(h.calls).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(before + 1);
    await h.scheduler.stop();
  });

  it("a failed outcome counts like a thrown error; retryAfterMs delays the retry", async () => {
    const outcomes: FullRunOutcome[] = [
      { status: "failed", kind: "rate_limited", retryAfterMs: 40 * MINUTE },
      { status: "failed", kind: "server" },
      { status: "skipped", reason: "other_instance" },
    ];
    const h = start(
      { startupDelayMs: 0, intervalMs: 60 * MINUTE },
      { runFull: async () => outcomes.shift() ?? { status: "ok" } },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const times = h.calls.filter((c) => c[1].startsWith("full")).map((c) => c[0] / MINUTE);
    expect(times).toEqual([0, 40, 42]);
    // A skip is not a failure: the next run comes after the full interval.
    expect(h.scheduler.failures).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(h.calls.filter((c) => c[1].startsWith("full")).map((c) => c[0] / MINUTE)).toEqual([
      0, 40, 42, 102,
    ]);
    expect(h.log.find("sync.schedule.skipped")[0]).toMatchObject({ reason: "other_instance" });
    await h.scheduler.stop();
  });

  it("computes failure delays", () => {
    const s = { intervalMs: 60 * MINUTE, retryBaseMs: MINUTE, maxBackoffMs: 15 * MINUTE };
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => failureDelayMs(s, n) / MINUTE)).toEqual([
      1, 2, 4, 8, 15, 15, 15,
    ]);
    // Never later than the normal interval.
    expect(failureDelayMs({ ...s, intervalMs: 5 * MINUTE }, 6)).toBe(5 * MINUTE);
    // Periodic runs off: the backoff alone.
    expect(failureDelayMs({ ...s, intervalMs: 0 }, 6)).toBe(15 * MINUTE);
    // A rate limit's retry time, bounded by the longer of interval and cap.
    expect(failureDelayMs(s, 1, 30 * MINUTE)).toBe(30 * MINUTE);
    expect(failureDelayMs(s, 1, 10 * 60 * MINUTE)).toBe(60 * MINUTE);
    expect(failureDelayMs(s, 1, null)).toBe(MINUTE);
    expect(failureDelayMs(s, 1, Number.NaN)).toBe(MINUTE);
  });

  it("with periodic runs off, a failed startup run is retried until it succeeds", async () => {
    let failuresLeft = 2;
    const h = start(
      { startupDelayMs: 0, intervalMs: 0 },
      {
        runFull: async () => {
          if (failuresLeft-- > 0) return { status: "failed" };
          return { status: "ok" };
        },
      },
    );
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(h.calls.filter((c) => c[1].startsWith("full")).map((c) => c[0] / MINUTE)).toEqual([
      0, 1, 3,
    ]);
    expect(h.calls.map((c) => c[1])).toEqual([
      "reap",
      "full:startup",
      "full:schedule",
      "full:schedule",
    ]);
    await h.scheduler.stop();
  });

  it("disabled settings do nothing but the startup reap", async () => {
    const h = start({ onStartup: false, intervalMs: 0, drainIntervalMs: 0, startupDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * MINUTE);
    expect(h.calls).toEqual([[0, "reap"]]);
    expect(vi.getTimerCount()).toBe(0);
    await h.scheduler.stop();
  });

  it("stop cancels pending timers and aborts the run in progress", async () => {
    const run = deferred<FullRunOutcome>();
    const h = start(
      { startupDelayMs: 0, intervalMs: 60 * MINUTE, drainIntervalMs: MINUTE },
      { runFull: () => run.promise },
    );
    await vi.advanceTimersByTimeAsync(0);
    const signal = h.signals[0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    let stopped = false;
    const stopping = h.scheduler.stop().then(() => (stopped = true));
    expect(h.scheduler.active).toBe(false);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    // stop() waits for the run to settle.
    expect(stopped).toBe(false);
    run.resolve({ status: "skipped", reason: "aborted" });
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * MINUTE);
    expect(h.calls.map((c) => c[1])).toEqual(["reap", "full:startup"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.log.find("sync.scheduler.stopped")).toHaveLength(1);
    // Idempotent.
    await h.scheduler.stop();
    expect(h.log.find("sync.scheduler.stopped")).toHaveLength(1);
  });

  it("stop before the startup delay runs nothing", async () => {
    const h = start({ startupDelayMs: 10 * SECOND, drainIntervalMs: MINUTE });
    await h.scheduler.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(h.calls).toEqual([]);
  });

  it("bounds a drain tick by drainTimeoutMs and keeps draining after an error", async () => {
    let first = true;
    const h = start(
      {
        onStartup: false,
        intervalMs: 0,
        startupDelayMs: 0,
        drainIntervalMs: MINUTE,
        drainTimeoutMs: 30 * SECOND,
      },
      {
        drain: (signal) => {
          if (!first) throw new Error("drain broke");
          first = false;
          return new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      },
    );
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.scheduler.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.scheduler.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(h.calls.filter((c) => c[1] === "drain").length).toBeGreaterThanOrEqual(3);
    expect(h.log.find("sync.schedule.drain_failed").length).toBeGreaterThanOrEqual(1);
    await h.scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a reap failure is logged and the startup run still happens", async () => {
    const h = start(
      { startupDelayMs: 0, intervalMs: 0 },
      {
        reap: async () => {
          throw new Error("db down");
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.map((c) => c[1])).toEqual(["full:startup"]);
    expect(h.log.find("sync.schedule.reap_failed")).toHaveLength(1);
    await h.scheduler.stop();
  });

  it("rejects invalid settings before setting any timer", () => {
    const deps: SchedulerDeps = {
      runFull: async () => ({ status: "ok" }),
      drain: async () => undefined,
      reap: async () => undefined,
    };
    for (const bad of [
      { intervalMs: -1 },
      { startupDelayMs: Number.NaN },
      { drainIntervalMs: Number.POSITIVE_INFINITY },
      { jitter: 0.9 },
      { jitter: -0.1 },
      { onStartup: "yes" as unknown as boolean },
    ]) {
      expect(() => startScheduler({ ...DEFAULT_SCHEDULER_SETTINGS, ...bad }, deps)).toThrow(
        TypeError,
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("unrefTimers", () => {
  it("never keeps the process alive", () => {
    const handle = unrefTimers.setTimeout(() => undefined, 60_000) as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    unrefTimers.clearTimeout(handle);
  });
});
