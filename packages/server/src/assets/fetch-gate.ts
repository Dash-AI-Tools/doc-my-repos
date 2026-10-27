/**
 * Admission control for the image proxy's upstream fetches (hardening of task 7.5). Without it,
 * N parallel cache misses mean N GitHub requests and up to N x 10 MiB of image bytes in memory at
 * once. The gate bounds all three:
 *
 * - Concurrency: at most `maxInFlight` fetches run at once (default 6). Further fetches wait in a
 *   FIFO queue of at most `maxQueue` entries (default 50); a fetch that finds the queue full is
 *   refused at once (`overloaded`, which the proxy answers with 503 and `Retry-After`), and one
 *   that waits longer than `queueTimeoutMs` gives up the same way.
 * - Memory: every fetch reserves `cost` bytes (the proxy's size limit, since the real size is not
 *   known before the download: the sync stores no sizes for images) against a total `byteBudget`
 *   (default 64 MiB). A fetch starts only when its reservation fits, so in-flight bytes never
 *   exceed the budget. A lone fetch always starts, even when its cost alone exceeds the budget.
 * - Single flight: concurrent calls with the same `key` share one fetch and its result. The fetch
 *   is aborted only when every caller that joined it has gone away, so one impatient client
 *   cannot cancel the download for the others, and the last one leaving does not leave a
 *   download running for nobody.
 *
 * The slot (and the bytes reservation) is released in a `finally`, so a task that throws, is
 * aborted or times out never leaks capacity. Joiners do not take queue space, so a popular image
 * costs one slot however many people ask for it.
 *
 * Per process, like the asset cache. No dependencies; the task decides what a fetch is.
 */

export const DEFAULT_FETCH_CONCURRENCY = 6;
export const DEFAULT_FETCH_QUEUE = 50;
export const DEFAULT_FETCH_BYTE_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_QUEUE_TIMEOUT_MS = 10_000;

export interface FetchGateOptions {
  maxInFlight?: number;
  maxQueue?: number;
  byteBudget?: number;
}

export interface GateRunOptions {
  /** The caller's own signal (the request going away). */
  signal?: AbortSignal;
  /** Longest wait for a slot. Applied by the caller that starts the shared fetch. */
  queueTimeoutMs?: number;
}

export type GateResult<T> =
  /** The task ran (here or for another caller with the same key) and returned `value`. */
  | { readonly kind: "done"; readonly value: T }
  /** The queue was full, or no slot came free in time. Nothing was fetched. */
  | { readonly kind: "overloaded" }
  /** Every caller left (or this caller's signal fired) before a result existed. */
  | { readonly kind: "aborted" };

export interface FetchGate {
  /**
   * Runs `task` under the limits, or joins the running task with the same `key`. `task` gets a
   * signal that fires when all callers have gone. A task that throws makes every caller's promise
   * reject with that error; the slot is freed first.
   */
  run<T>(
    key: string,
    cost: number,
    task: (signal: AbortSignal) => Promise<T>,
    options?: GateRunOptions,
  ): Promise<GateResult<T>>;
  /** Fetches running and waiting, bytes reserved, and distinct keys in flight. For tests. */
  stats(): { inFlight: number; queued: number; reservedBytes: number; flights: number };
}

interface QueueEntry {
  readonly cost: number;
  readonly grant: (release: () => void) => void;
}

interface Flight {
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
  promise: Promise<GateResult<unknown>>;
}

type Slot = { readonly kind: "slot"; readonly release: () => void };

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function createFetchGate(options: FetchGateOptions = {}): FetchGate {
  const maxInFlight = positive(options.maxInFlight, DEFAULT_FETCH_CONCURRENCY);
  const maxQueue = Math.max(0, Math.floor(options.maxQueue ?? DEFAULT_FETCH_QUEUE));
  const byteBudget = positive(options.byteBudget, DEFAULT_FETCH_BYTE_BUDGET);

  let inFlight = 0;
  let reserved = 0;
  const queue: QueueEntry[] = [];
  const flights = new Map<string, Flight>();

  const fits = (cost: number): boolean =>
    inFlight < maxInFlight && (inFlight === 0 || reserved + cost <= byteBudget);

  const take = (cost: number): (() => void) => {
    inFlight += 1;
    reserved += cost;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      reserved -= cost;
      pump();
    };
  };

  function pump(): void {
    for (;;) {
      const head = queue[0];
      if (head === undefined || !fits(head.cost)) return;
      queue.shift();
      head.grant(take(head.cost));
    }
  }

  /** A slot now, or after waiting; or the reason there is none. */
  function acquire(
    cost: number,
    signal: AbortSignal,
    queueTimeoutMs: number,
  ): Promise<Slot | "overloaded" | "aborted"> {
    if (signal.aborted) return Promise.resolve("aborted");
    if (queue.length === 0 && fits(cost)) {
      return Promise.resolve({ kind: "slot", release: take(cost) });
    }
    if (queue.length >= maxQueue) return Promise.resolve("overloaded");
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: QueueEntry = {
        cost,
        grant: (release) => {
          cleanup();
          resolve({ kind: "slot", release });
        },
      };
      const leave = (reason: "overloaded" | "aborted") => () => {
        const at = queue.indexOf(entry);
        if (at === -1) return;
        queue.splice(at, 1);
        cleanup();
        resolve(reason);
        // The entry may have been blocking the ones behind it.
        pump();
      };
      const onAbort = leave("aborted");
      function cleanup() {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      if (Number.isFinite(queueTimeoutMs)) timer = setTimeout(leave("overloaded"), queueTimeoutMs);
      queue.push(entry);
    });
  }

  function startFlight<T>(
    key: string,
    cost: number,
    task: (signal: AbortSignal) => Promise<T>,
    queueTimeoutMs: number,
  ): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      waiters: 0,
      settled: false,
      promise: Promise.resolve({ kind: "aborted" }),
    };
    const reservation = Math.min(Math.max(0, cost), byteBudget);
    flight.promise = (async (): Promise<GateResult<T>> => {
      const slot = await acquire(reservation, controller.signal, queueTimeoutMs);
      if (slot === "overloaded" || slot === "aborted") return { kind: slot };
      try {
        return { kind: "done", value: await task(controller.signal) };
      } finally {
        slot.release();
      }
    })().finally(() => {
      flight.settled = true;
      if (flights.get(key) === flight) flights.delete(key);
    });
    // A flight whose callers all left may reject with nobody listening.
    flight.promise.catch(() => undefined);
    flights.set(key, flight);
    return flight;
  }

  function join<T>(key: string, flight: Flight, signal: AbortSignal | undefined) {
    return new Promise<GateResult<T>>((resolve, reject) => {
      flight.waiters += 1;
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        signal?.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        if (flight.waiters === 0 && !flight.settled) {
          // Nobody wants the result any more: stop the download, and let a later request for
          // the same key start afresh instead of joining an aborted fetch.
          if (flights.get(key) === flight) flights.delete(key);
          flight.controller.abort();
        }
        return true;
      };
      const onAbort = () => {
        if (leave()) resolve({ kind: "aborted" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (result) => {
          if (leave()) resolve(result as GateResult<T>);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
    });
  }

  return {
    run(key, cost, task, runOptions = {}) {
      // Checked before a flight can be started with nobody waiting on it.
      if (runOptions.signal?.aborted) return Promise.resolve({ kind: "aborted" });
      const existing = flights.get(key);
      const flight =
        existing !== undefined && !existing.controller.signal.aborted
          ? existing
          : startFlight(key, cost, task, runOptions.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
      return join(key, flight, runOptions.signal);
    },
    stats: () => ({
      inFlight,
      queued: queue.length,
      reservedBytes: reserved,
      flights: flights.size,
    }),
  };
}
