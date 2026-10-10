import { describe, expect, it, vi } from "vitest";

import { createFetchGate, DEFAULT_FETCH_BYTE_BUDGET } from "./fetch-gate";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending microtasks (promise continuations) run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const MIB = 1024 * 1024;

describe("createFetchGate: concurrency", () => {
  it("runs at most maxInFlight tasks at once and starts the next as one finishes", async () => {
    const gate = createFetchGate({ maxInFlight: 2, maxQueue: 10 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const results = gates.map((g, i) =>
      gate.run(`k${i}`, 1, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
        return i;
      }),
    );
    await tick();
    expect(running).toBe(2);
    expect(gate.stats()).toMatchObject({ inFlight: 2, queued: 2 });
    gates[0]!.resolve();
    await tick();
    expect(running).toBe(2);
    expect(gate.stats()).toMatchObject({ inFlight: 2, queued: 1 });
    for (const g of gates) g.resolve();
    expect(await Promise.all(results)).toEqual(
      [0, 1, 2, 3].map((value) => ({ kind: "done", value })),
    );
    expect(peak).toBe(2);
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
  });

  it("serves the queue in arrival order", async () => {
    const gate = createFetchGate({ maxInFlight: 1, maxQueue: 10 });
    const first = deferred();
    const order: string[] = [];
    const run = (key: string, wait?: Deferred) =>
      gate.run(key, 1, async () => {
        order.push(key);
        await wait?.promise;
      });
    const all = [run("a", first), run("b"), run("c"), run("d")];
    await tick();
    first.resolve();
    await Promise.all(all);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("refuses with overloaded when the queue is full, without running the task", async () => {
    const gate = createFetchGate({ maxInFlight: 1, maxQueue: 2 });
    const hold = deferred();
    const task = vi.fn(async () => {
      await hold.promise;
      return "ok";
    });
    const accepted = ["a", "b", "c"].map((key) => gate.run(key, 1, task));
    await tick();
    expect(gate.stats()).toMatchObject({ inFlight: 1, queued: 2 });
    const refusedTask = vi.fn(async () => "never");
    expect(await gate.run("d", 1, refusedTask)).toEqual({ kind: "overloaded" });
    expect(refusedTask).not.toHaveBeenCalled();
    // The refusal left nothing behind: the queue still drains.
    hold.resolve();
    expect(await Promise.all(accepted)).toEqual(
      ["ok", "ok", "ok"].map((value) => ({ kind: "done", value })),
    );
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
  });

  it("with maxQueue 0 refuses anything that cannot start at once", async () => {
    const gate = createFetchGate({ maxInFlight: 1, maxQueue: 0 });
    const hold = deferred();
    const first = gate.run("a", 1, () => hold.promise);
    expect(await gate.run("b", 1, async () => 1)).toEqual({ kind: "overloaded" });
    hold.resolve();
    await first;
  });

  it("gives up a queued fetch after queueTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const gate = createFetchGate({ maxInFlight: 1, maxQueue: 5 });
      const hold = deferred();
      const first = gate.run("a", 1, () => hold.promise);
      const task = vi.fn(async () => 1);
      const waiting = gate.run("b", 1, task, { queueTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(999);
      expect(gate.stats().queued).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(await waiting).toEqual({ kind: "overloaded" });
      expect(task).not.toHaveBeenCalled();
      expect(gate.stats()).toMatchObject({ inFlight: 1, queued: 0, flights: 1 });
      hold.resolve();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createFetchGate: byte budget", () => {
  it("never reserves more than the budget: big fetches wait for each other", async () => {
    const gate = createFetchGate({ maxInFlight: 6, maxQueue: 20, byteBudget: 25 * MIB });
    const holds = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const results = holds.map((h, i) =>
      gate.run(`k${i}`, 10 * MIB, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await h.promise;
        running -= 1;
      }),
    );
    await tick();
    // 2 x 10 MiB fit in 25 MiB; a third would be 30 MiB.
    expect(running).toBe(2);
    expect(gate.stats()).toMatchObject({ inFlight: 2, queued: 2, reservedBytes: 20 * MIB });
    for (const h of holds) h.resolve();
    await Promise.all(results);
    expect(peak).toBe(2);
    expect(gate.stats().reservedBytes).toBe(0);
  });

  it("with the default budget and 10 MiB images, runs six at a time", async () => {
    expect(DEFAULT_FETCH_BYTE_BUDGET).toBe(64 * MIB);
    const gate = createFetchGate();
    const hold = deferred();
    let running = 0;
    const results = Array.from({ length: 8 }, (_, i) =>
      gate.run(`k${i}`, 10 * MIB, async () => {
        running += 1;
        await hold.promise;
      }),
    );
    await tick();
    expect(running).toBe(6);
    expect(gate.stats().reservedBytes).toBe(60 * MIB);
    hold.resolve();
    await Promise.all(results);
  });

  it("lets a lone fetch run even if its cost exceeds the budget", async () => {
    const gate = createFetchGate({ byteBudget: 5 * MIB });
    expect(await gate.run("a", 50 * MIB, async () => "ran")).toEqual({
      kind: "done",
      value: "ran",
    });
  });

  it("a small fetch behind a big one waits its turn (FIFO) instead of jumping the queue", async () => {
    const gate = createFetchGate({ maxInFlight: 3, maxQueue: 5, byteBudget: 10 * MIB });
    const hold = deferred();
    const started: string[] = [];
    const run = (key: string, cost: number) =>
      gate.run(key, cost, async () => {
        started.push(key);
        await hold.promise;
      });
    const all = [run("a", 8 * MIB), run("big", 8 * MIB), run("small", 1 * MIB)];
    await tick();
    expect(started).toEqual(["a"]);
    hold.resolve();
    await Promise.all(all);
    expect(started).toEqual(["a", "big", "small"]);
  });
});

describe("createFetchGate: single flight", () => {
  it("shares one task and its result between concurrent calls with the same key", async () => {
    const gate = createFetchGate();
    const hold = deferred<string>();
    const task = vi.fn(() => hold.promise);
    const calls = Array.from({ length: 10 }, () => gate.run("same", 1, task));
    await tick();
    expect(task).toHaveBeenCalledTimes(1);
    expect(gate.stats()).toMatchObject({ inFlight: 1, queued: 0, flights: 1 });
    hold.resolve("bytes");
    const results = await Promise.all(calls);
    expect(results).toEqual(Array.from({ length: 10 }, () => ({ kind: "done", value: "bytes" })));
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
  });

  it("joiners take neither a slot nor queue space", async () => {
    const gate = createFetchGate({ maxInFlight: 1, maxQueue: 1 });
    const hold = deferred();
    const task = () => hold.promise;
    const all = [
      gate.run("busy", 1, task),
      gate.run("queued", 1, task),
      // The queue is full for a new key, but these join existing flights.
      ...Array.from({ length: 20 }, () => gate.run("busy", 1, task)),
      ...Array.from({ length: 20 }, () => gate.run("queued", 1, task)),
    ];
    await tick();
    expect(gate.stats()).toMatchObject({ inFlight: 1, queued: 1, flights: 2 });
    expect(await gate.run("third", 1, task)).toEqual({ kind: "overloaded" });
    hold.resolve();
    expect((await Promise.all(all)).every((r) => r.kind === "done")).toBe(true);
  });

  it("starts a new task for the same key once the first has finished", async () => {
    const gate = createFetchGate();
    const task = vi.fn(async () => "v");
    await gate.run("k", 1, task);
    await gate.run("k", 1, task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("keeps different keys apart", async () => {
    const gate = createFetchGate();
    const task = vi.fn(async () => "v");
    await Promise.all([gate.run("a", 1, task), gate.run("b", 1, task)]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not abort the shared fetch while another caller still waits", async () => {
    const gate = createFetchGate();
    const hold = deferred<string>();
    let seen: AbortSignal | undefined;
    const task = (signal: AbortSignal) => {
      seen = signal;
      return hold.promise;
    };
    const impatient = new AbortController();
    const first = gate.run("k", 1, task, { signal: impatient.signal });
    const patient = gate.run("k", 1, task);
    await tick();
    impatient.abort();
    expect(await first).toEqual({ kind: "aborted" });
    expect(seen?.aborted).toBe(false);
    hold.resolve("done");
    expect(await patient).toEqual({ kind: "done", value: "done" });
  });

  it("aborts the fetch once the last caller has gone, and frees its slot when the task ends", async () => {
    const gate = createFetchGate({ maxInFlight: 1 });
    let seen: AbortSignal | undefined;
    const task = (signal: AbortSignal) =>
      new Promise<string>((_, reject) => {
        seen = signal;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const a = new AbortController();
    const b = new AbortController();
    const one = gate.run("k", 1, task, { signal: a.signal });
    const two = gate.run("k", 1, task, { signal: b.signal });
    await tick();
    a.abort();
    await one;
    expect(seen?.aborted).toBe(false);
    b.abort();
    expect(await two).toEqual({ kind: "aborted" });
    expect(seen?.aborted).toBe(true);
    await tick();
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
    // The slot is free again, and the key starts afresh.
    expect(await gate.run("k", 1, async () => "again")).toEqual({ kind: "done", value: "again" });
  });

  it("a new request for a key whose callers all left does not join the aborted fetch", async () => {
    const gate = createFetchGate();
    const first = deferred<string>();
    let aborted = false;
    const abandoned = new AbortController();
    const one = gate.run(
      "k",
      1,
      (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return first.promise;
      },
      { signal: abandoned.signal },
    );
    await tick();
    abandoned.abort();
    await one;
    expect(aborted).toBe(true);
    const fresh = await gate.run("k", 1, async () => "fresh");
    expect(fresh).toEqual({ kind: "done", value: "fresh" });
    first.resolve("stale");
  });

  it("returns aborted at once for a signal that is already aborted, and runs nothing", async () => {
    const gate = createFetchGate();
    const task = vi.fn(async () => 1);
    const signal = AbortSignal.abort();
    expect(await gate.run("k", 1, task, { signal })).toEqual({ kind: "aborted" });
    expect(task).not.toHaveBeenCalled();
    expect(gate.stats().flights).toBe(0);
  });

  it("removes a queued fetch whose callers left, so it never runs and unblocks the others", async () => {
    const gate = createFetchGate({ maxInFlight: 1, maxQueue: 5 });
    const hold = deferred();
    const first = gate.run("a", 1, () => hold.promise);
    const gone = new AbortController();
    const skipped = vi.fn(async () => 1);
    const queued = gate.run("b", 1, skipped, { signal: gone.signal });
    const behind = gate.run("c", 1, async () => "c");
    await tick();
    expect(gate.stats().queued).toBe(2);
    gone.abort();
    expect(await queued).toEqual({ kind: "aborted" });
    await tick();
    expect(gate.stats().queued).toBe(1);
    hold.resolve();
    await first;
    expect(await behind).toEqual({ kind: "done", value: "c" });
    expect(skipped).not.toHaveBeenCalled();
  });
});

describe("createFetchGate: release on failure", () => {
  it("frees the slot and the reservation when the task throws, and rejects every caller", async () => {
    const gate = createFetchGate({ maxInFlight: 1, byteBudget: 10 * MIB });
    const hold = deferred<void>();
    const failing = () => hold.promise.then(() => Promise.reject(new Error("boom")));
    const calls = [gate.run("k", 10 * MIB, failing), gate.run("k", 10 * MIB, failing)];
    const settled = Promise.allSettled(calls);
    await tick();
    hold.resolve();
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
    expect(await gate.run("next", 10 * MIB, async () => "ok")).toEqual({
      kind: "done",
      value: "ok",
    });
  });

  it("frees the slot when the task throws synchronously", async () => {
    const gate = createFetchGate({ maxInFlight: 1 });
    await expect(
      gate.run("k", 1, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(gate.stats().inFlight).toBe(0);
    expect(await gate.run("k2", 1, async () => 1)).toEqual({ kind: "done", value: 1 });
  });

  it("does not leave an unhandled rejection when every caller left before the task failed", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const gate = createFetchGate();
      const gone = new AbortController();
      const call = gate.run(
        "k",
        1,
        (signal) =>
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("late"))),
          ),
        { signal: gone.signal },
      );
      await tick();
      gone.abort();
      await call;
      await tick();
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
      expect(gate.stats().inFlight).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("createFetchGate: options", () => {
  it("falls back to the defaults for unusable values", async () => {
    const gate = createFetchGate({ maxInFlight: Number.NaN, byteBudget: -1 });
    const hold = deferred();
    let running = 0;
    const calls = Array.from({ length: 8 }, (_, i) =>
      gate.run(`k${i}`, 1, async () => {
        running += 1;
        await hold.promise;
      }),
    );
    await tick();
    expect(running).toBe(6);
    hold.resolve();
    await Promise.all(calls);
  });
});
