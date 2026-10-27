import { inspect } from "node:util";

import type { PoolClient, QueryResult } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdvisoryLockError,
  REPO_SYNC_LOCK_NAMESPACE,
  advisoryLockKey,
  pollDelayMs,
  repoSyncLockKey,
  withAdvisoryLock,
  withRepoSyncLock,
} from "./advisory-lock";
import { createDb, type DbHandle } from "./client";
import { closeWithin, createTestDatabase, describeDb, type TestDatabase } from "./test-db";

const REPO = { githubId: 1296269 };
const OTHER_REPO = { githubId: 1300192 };

// Captured before any test fakes timers, so time limits in tests keep running on the real clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** A promise plus its resolver, for deterministic hand-offs between concurrent callers. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

/** Real-clock delay, unaffected by fake timers. */
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** Rejects if `promise` does not settle within `ms` of real time. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${what}: not settled within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => realClearTimeout(timer));
}

const INVALID_ERROR = "advisory lock: githubId must be a positive integer";

describe("advisory lock keys", () => {
  it("are deterministic signed 64-bit integers", () => {
    const key = repoSyncLockKey(REPO);
    expect(key).toBe(repoSyncLockKey({ ...REPO }));
    expect(key).toMatch(/^-?\d+$/);
    const n = BigInt(key);
    expect(n >= -(2n ** 63n) && n < 2n ** 63n).toBe(true);
  });

  it("give the number, bigint and string forms of one id the same key", () => {
    const key = repoSyncLockKey({ githubId: 1296269 });
    expect(repoSyncLockKey({ githubId: 1296269n })).toBe(key);
    expect(repoSyncLockKey({ githubId: "1296269" })).toBe(key);
    const big = repoSyncLockKey({ githubId: 2n ** 63n - 1n });
    expect(repoSyncLockKey({ githubId: "9223372036854775807" })).toBe(big);
  });

  it("canonicalize decimal strings with leading zeros", () => {
    const key = repoSyncLockKey({ githubId: 7 });
    expect(repoSyncLockKey({ githubId: "007" })).toBe(key);
    expect(repoSyncLockKey({ githubId: "0007" })).toBe(key);
    expect(repoSyncLockKey({ githubId: 7n })).toBe(key);
    expect(advisoryLockKey(REPO_SYNC_LOCK_NAMESPACE, "7")).toBe(key);
    expect(advisoryLockKey(REPO_SYNC_LOCK_NAMESPACE, "007")).not.toBe(key);
  });

  it("differ between repository ids", () => {
    expect(repoSyncLockKey(OTHER_REPO)).not.toBe(repoSyncLockKey(REPO));
    expect(repoSyncLockKey({ githubId: 1 })).not.toBe(repoSyncLockKey({ githubId: 2 }));
  });

  it("reject anything but a positive integer that fits a bigint, with a fixed message", () => {
    const invalid: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      0n,
      -5n,
      2n ** 63n,
      "",
      "0",
      "-1",
      "1.0",
      " 1",
      "1e3",
      "0x10",
      "abc",
      "9223372036854775808",
      "12345678901234567890",
      null,
      undefined,
      {},
    ];
    for (const githubId of invalid) {
      const call = () => repoSyncLockKey({ githubId } as { githubId: number });
      expect(call, String(githubId)).toThrow(AdvisoryLockError);
      expect(call, String(githubId)).toThrow(INVALID_ERROR);
    }
  });

  it("cannot collide across namespaces by construction", () => {
    // The repo key is the generic key in its own namespace over the canonical decimal id.
    expect(advisoryLockKey(REPO_SYNC_LOCK_NAMESPACE, "1296269")).toBe(repoSyncLockKey(REPO));
    // The same identity in another namespace hashes a different input.
    expect(advisoryLockKey("docmyrepos:migrations", "1296269")).not.toBe(repoSyncLockKey(REPO));
    // A namespace cannot contain the NUL separator, so `ns\0id` splits only one way.
    expect(() => advisoryLockKey(`${REPO_SYNC_LOCK_NAMESPACE}\0x`, "1")).toThrow(
      "advisory lock: namespace must not contain a NUL character",
    );
    expect(() => advisoryLockKey("\0", "")).toThrow(AdvisoryLockError);
    // NUL in the identity is fine: the first NUL is always the separator.
    expect(advisoryLockKey("a", "b\0c")).not.toBe(advisoryLockKey("a", "b"));
  });
});

describe("wait-mode poll delay", () => {
  const sequence = (random: () => number) =>
    Array.from({ length: 8 }, (_, attempt) => pollDelayMs(attempt, random));

  it("doubles from 20 ms and caps at 250 ms before jitter", () => {
    expect(sequence(() => 0.5)).toEqual([20, 40, 80, 160, 250, 250, 250, 250]);
    expect(pollDelayMs(1_000, () => 0.5)).toBe(250);
  });

  it("jitters each delay within plus or minus 20 percent", () => {
    expect(sequence(() => 0)).toEqual([16, 32, 64, 128, 200, 200, 200, 200]);
    const high = sequence(() => 0.999_999);
    expect(high.every((d, i) => d < [24, 48, 96, 192, 300, 300, 300, 300][i]!)).toBe(true);
    expect(
      high.every((d, i) => d > [23.9, 47.9, 95.9, 191.9, 299.9, 299.9, 299.9, 299.9][i]!),
    ).toBe(true);
    for (let i = 0; i < 200; i++) {
      const d = pollDelayMs(10);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThan(300);
    }
  });
});

describe("advisory lock options", () => {
  // The pool is never touched: validation runs before any connection.
  const handle = createDb("postgres://u:p@127.0.0.1:1/never");
  const pool = handle.pool;
  afterAll(() => handle.close());

  it("rejects a waitMs that is not a number >= 0, without connecting", async () => {
    for (const waitMs of [Number.NaN, -1, -0.5, Number.NEGATIVE_INFINITY, "10", null]) {
      const fn = vi.fn(async () => 1);
      const error = await withRepoSyncLock(pool, REPO, fn, {
        waitMs: waitMs as number,
      }).catch((e: unknown) => e);
      expect(error, String(waitMs)).toBeInstanceOf(AdvisoryLockError);
      expect((error as Error).message).toBe("advisory lock: waitMs must be a number >= 0");
      expect(fn).not.toHaveBeenCalled();
    }
    expect(pool.totalCount).toBe(0);
  });
});

describe("advisory lock on an unreachable database", () => {
  const PASSWORD = "sentinel_pass_p9";
  const USER = "sentinel_user_u7";
  const URL_TEXT = `postgres://${USER}:${PASSWORD}@127.0.0.1:1/sentinel_db_d5`;

  it("throws a fixed message without the URL, user or password", async () => {
    const handle = createDb(URL_TEXT);
    try {
      const error = await withRepoSyncLock(handle.pool, REPO, async () => 1).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AdvisoryLockError);
      expect((error as Error).message).toBe(
        "advisory lock: cannot connect, database error (ECONNREFUSED)",
      );
      const text = [
        String(error),
        (error as Error).stack ?? "",
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
        inspect(error, { showHidden: true, depth: null }),
      ].join("\n");
      for (const word of [PASSWORD, USER, "sentinel_db_d5", "127.0.0.1"]) {
        expect(text).not.toContain(word);
      }
    } finally {
      await handle.close();
    }
  });
});

type Step = "try" | "unlock";

interface LockCall {
  step: Step;
  /** Backend pid of the session that ran it. */
  pid: number;
  /** The boolean the query returned, once it returned. */
  result?: boolean;
}

interface Interception {
  step: Step;
  client: PoolClient;
  key: string;
  /** Runs the helper's query unchanged. */
  run: () => Promise<QueryResult>;
  /** Runs any query on the same session, bypassing the instrumentation. */
  raw: (text: string, values?: unknown[]) => Promise<QueryResult>;
}

/**
 * A pool whose clients report every advisory-lock query the helper runs, and let a test replace
 * one: throw, return a fake row, or fail on the live session. Other queries pass through.
 */
interface Instrumented extends DbHandle {
  readonly calls: LockCall[];
  intercept?: (call: Interception) => Promise<QueryResult>;
  /** Called with each lock query's result, before the helper sees it. */
  onResult?: (call: LockCall) => void;
}

function instrument(url: string, options: { max: number; connectTimeoutMs?: number }) {
  const handle = createDb(url, options);
  const inst: Instrumented = { ...handle, calls: [] };
  handle.pool.on("connect", (client) => {
    type Query = (...args: unknown[]) => Promise<QueryResult>;
    const original = client.query.bind(client) as unknown as Query;
    const pid = (client as unknown as { processID: number }).processID;
    const wrapped: Query = (...args) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      const step: Step | undefined = text.includes("pg_try_advisory_lock")
        ? "try"
        : text.includes("pg_advisory_unlock")
          ? "unlock"
          : undefined;
      if (step === undefined) return original(...args);
      const call: LockCall = { step, pid };
      inst.calls.push(call);
      const key = String((args[1] as unknown[] | undefined)?.[0]);
      const run = () => original(...args);
      const raw = (t: string, values?: unknown[]) => original(t, values);
      const pending = inst.intercept ? inst.intercept({ step, client, key, run, raw }) : run();
      return pending.then((res) => {
        const row = res.rows[0] as { acquired?: boolean; unlocked?: boolean } | undefined;
        call.result = row?.acquired ?? row?.unlocked;
        inst.onResult?.(call);
        return res;
      });
    };
    client.query = wrapped as unknown as typeof client.query;
  });
  return inst;
}

/** A query result with one row, for faking what the helper reads. */
function fakeRow(row: Record<string, unknown>): QueryResult {
  return { rows: [row], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
}

describeDb("advisory lock on a real database", () => {
  let t: TestDatabase;
  /** A second pool on the same database: another process, as far as Postgres is concerned. */
  let other: DbHandle;
  /** A fresh instrumented pool per test, so its `totalCount` starts at 0. */
  let inst: Instrumented;

  beforeAll(async () => {
    t = await createTestDatabase();
    other = createDb(t.url.reveal(), { max: 25 });
  }, 60_000);

  afterAll(async () => {
    // Bounded: a client a failed test never released would keep `close()` pending forever, and
    // `drop()` force-drops the database anyway, ending any session still open.
    if (other) await closeWithin(other, 2_000);
    await t?.drop();
  }, 60_000);

  beforeEach(() => {
    inst = instrument(t.url.reveal(), { max: 4 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    // A failed test can leave a holder waiting; release it so the pools can drain.
    await Promise.all(heldLocks.splice(0).map((release) => release()));
    inst.intercept = undefined;
    inst.onResult = undefined;
    try {
      await expectPoolsIdle();
      expect(await advisoryLocks()).toBe(0);
    } finally {
      await closeWithin(inst, 2_000);
    }
  });

  /** Advisory locks held by any session on the test database. */
  async function advisoryLocks(): Promise<number> {
    const res = await t.pool.query<{ n: string }>(
      `select count(*) as n from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())`,
    );
    return Number(res.rows[0]?.n);
  }

  /**
   * Backend pids holding the advisory lock `key` on the test database. Scoped to this database and
   * key, so locks held elsewhere on the server (another test run, `pnpm dev`) never show up.
   * A `bigint` key is stored as classid (high 32 bits), objid (low 32 bits) and objsubid 1.
   */
  async function lockHolders(key: string): Promise<number[]> {
    const res = await t.pool.query<{ pid: number }>(
      `select pid from pg_locks
        where locktype = 'advisory' and granted and objsubid = 1
          and database = (select oid from pg_database where datname = current_database())
          and ((classid::int8 << 32) | objid::int8) = $1::int8`,
      [key],
    );
    return res.rows.map((r) => r.pid);
  }

  /** Whether backend `pid` is still connected to the test database. */
  async function sessionExists(pid: number): Promise<boolean> {
    const res = await t.pool.query(
      "select 1 from pg_stat_activity where pid = $1 and datname = current_database()",
      [pid],
    );
    return res.rows.length > 0;
  }

  /** Every client of every pool is back in its pool (none checked out or leaked). */
  async function expectPoolsIdle(): Promise<void> {
    await vi.waitFor(() => {
      for (const pool of [t.pool, other.pool, inst.pool]) {
        expect(pool.totalCount - pool.idleCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
      }
    });
  }

  /**
   * The lock client was destroyed rather than pooled: the pool is empty, the session is gone,
   * no advisory lock remains, and the pool still works.
   */
  async function expectDestroyedAndRecovered(pid: number): Promise<void> {
    await vi.waitFor(() => expect(inst.pool.totalCount).toBe(0));
    await vi.waitFor(async () => expect(await sessionExists(pid)).toBe(false));
    expect(await advisoryLocks()).toBe(0);
    inst.intercept = undefined;
    expect(await withRepoSyncLock(inst.pool, REPO, async () => "again")).toEqual({
      acquired: true,
      value: "again",
    });
    expect(await advisoryLocks()).toBe(0);
  }

  /** Releases of holders started by `holdLock`, run again after each test (idempotent). */
  const heldLocks: (() => Promise<void>)[] = [];

  /** Holds the repo lock on `t.pool` until `release` is called (or the test ends). */
  async function holdLock() {
    const held = gate();
    const release = gate();
    const done = withRepoSyncLock(t.pool, REPO, async () => {
      held.open();
      await release.promise;
      return "holder";
    });
    const releaseAndWait = async () => {
      release.open();
      await done;
    };
    heldLocks.push(releaseAndWait);
    await held.promise;
    return {
      release: async () => {
        await releaseAndWait();
        expect(await done).toEqual({ acquired: true, value: "holder" });
      },
    };
  }

  const tries = () => inst.calls.filter((c) => c.step === "try");

  it("refuses a second acquire from another connection while the first is held", async () => {
    const result = await withRepoSyncLock(t.pool, REPO, async () => {
      expect(await advisoryLocks()).toBe(1);
      expect(await lockHolders(repoSyncLockKey(REPO))).toHaveLength(1);
      return withRepoSyncLock(other.pool, REPO, async () => "second");
    });
    expect(result).toEqual({ acquired: true, value: { acquired: false, reason: "busy" } });
  });

  it("refuses a concurrent acquire from the same process and pool", async () => {
    const held = gate();
    const release = gate();
    const first = withRepoSyncLock(t.pool, REPO, async () => {
      held.open();
      await release.promise;
      return "first";
    });
    await held.promise;
    const second = await withRepoSyncLock(t.pool, REPO, async () => "second");
    release.open();
    expect(second).toEqual({ acquired: false, reason: "busy" });
    expect(await first).toEqual({ acquired: true, value: "first" });
  });

  it("lets different repos run at the same time", async () => {
    const result = await withRepoSyncLock(t.pool, REPO, async () =>
      withRepoSyncLock(other.pool, OTHER_REPO, async () => {
        expect(await advisoryLocks()).toBe(2);
        return "both";
      }),
    );
    expect(result).toEqual({ acquired: true, value: { acquired: true, value: "both" } });
  });

  it("makes the number, bigint and string forms of one id contend", async () => {
    const result = await withRepoSyncLock(t.pool, { githubId: 1296269n }, async () => ({
      asString: await withRepoSyncLock(other.pool, { githubId: "1296269" }, async () => "x"),
      asNumber: await withRepoSyncLock(other.pool, { githubId: 1296269 }, async () => "x"),
    }));
    expect(result).toEqual({
      acquired: true,
      value: {
        asString: { acquired: false, reason: "busy" },
        asNumber: { acquired: false, reason: "busy" },
      },
    });
  });

  it("does not contend with the same identity in another namespace", async () => {
    const otherKey = advisoryLockKey("docmyrepos:test-other", String(REPO.githubId));
    const result = await withRepoSyncLock(t.pool, REPO, async () =>
      withAdvisoryLock(other.pool, otherKey, async () => {
        expect(await advisoryLocks()).toBe(2);
        return "both";
      }),
    );
    expect(result).toEqual({ acquired: true, value: { acquired: true, value: "both" } });
  });

  it("rejects an invalid id before touching the database", async () => {
    const fn = vi.fn(async () => 1);
    await expect(withRepoSyncLock(inst.pool, { githubId: 0 }, fn)).rejects.toThrow(INVALID_ERROR);
    await expect(
      withRepoSyncLock(inst.pool, { githubId: "007x" }, fn, { waitMs: 10_000 }),
    ).rejects.toThrow(INVALID_ERROR);
    expect(fn).not.toHaveBeenCalled();
    expect(inst.pool.totalCount).toBe(0);
    expect(inst.calls).toHaveLength(0);
  });

  it("lets the lock holder close its pool, then releases the lock and drains the pool", async () => {
    let ending: Promise<void> | undefined;
    const result = await withRepoSyncLock(inst.pool, REPO, async () => {
      ending = inst.close();
      // The pool refuses new work while ending, but the held client keeps working.
      const refused = await withRepoSyncLock(inst.pool, OTHER_REPO, async () => 1).catch(
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(AdvisoryLockError);
      expect((refused as Error).message).toBe(
        "advisory lock: cannot connect, database error (unknown error)",
      );
      expect(await lockHolders(repoSyncLockKey(REPO))).toHaveLength(1);
      return "held";
    });
    expect(result).toEqual({ acquired: true, value: "held" });
    await within(ending!, 2_000, "pool end");
    expect(inst.calls.map((c) => [c.step, c.result])).toEqual([
      ["try", true],
      ["unlock", true],
    ]);
    expect(inst.pool.totalCount).toBe(0);
    expect(await advisoryLocks()).toBe(0);
  });

  it("releases the lock after the callback returns", async () => {
    expect(await withRepoSyncLock(t.pool, REPO, async () => 1)).toEqual({
      acquired: true,
      value: 1,
    });
    expect(await advisoryLocks()).toBe(0);
    expect(await withRepoSyncLock(other.pool, REPO, async () => 2)).toEqual({
      acquired: true,
      value: 2,
    });
  });

  it("releases the lock after the callback throws, and rethrows the same error", async () => {
    const boom = new Error("sync failed");
    const error = await withRepoSyncLock(t.pool, REPO, async () => {
      throw boom;
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(boom);
    expect(await advisoryLocks()).toBe(0);
    expect(await withRepoSyncLock(other.pool, REPO, async () => 2)).toEqual({
      acquired: true,
      value: 2,
    });
  });

  it("frees the lock when the holder's backend is killed, without the helper's cooperation", async () => {
    const after = await withRepoSyncLock(t.pool, REPO, async ({ signal }) => {
      const holders = await lockHolders(repoSyncLockKey(REPO));
      expect(holders).toHaveLength(1);
      const lostSignal = new Promise<void>((resolve) =>
        signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve()),
      );
      await other.pool.query("select pg_terminate_backend($1)", [holders[0]]);
      // The callback still runs, but the session that held the lock is gone, so Postgres freed it.
      // Bounded, so a missing signal fails the test instead of hanging it.
      await within(lostSignal, 5_000, "lost-connection signal");
      expect(signal.aborted).toBe(true);
      await vi.waitFor(async () => expect(await advisoryLocks()).toBe(0));
      return withRepoSyncLock(other.pool, REPO, async () => "taken over");
    });
    expect(after).toEqual({ acquired: true, value: { acquired: true, value: "taken over" } });
    // The dead client was destroyed, not returned to the pool, and the pool still works.
    await expectPoolsIdle();
    expect(await withRepoSyncLock(t.pool, REPO, async () => "again")).toEqual({
      acquired: true,
      value: "again",
    });
  });

  describe("when a lock query fails on a live session", () => {
    it("destroys the client when the unlock throws, and still returns the callback's value", async () => {
      inst.intercept = async (c) => {
        if (c.step === "unlock") throw new Error("injected unlock failure");
        return c.run();
      };
      const result = await withRepoSyncLock(inst.pool, REPO, async () => {
        // The unlock never runs, so this live session keeps the lock until it is destroyed.
        expect(await advisoryLocks()).toBe(1);
        return "done";
      });
      expect(result).toEqual({ acquired: true, value: "done" });
      const [, unlock] = inst.calls;
      expect(unlock?.step).toBe("unlock");
      await expectDestroyedAndRecovered(unlock!.pid);
    });

    it("destroys the client when the unlock throws after the callback threw, and rethrows the callback's error", async () => {
      inst.intercept = async (c) => {
        if (c.step === "unlock") throw new Error("injected unlock failure");
        return c.run();
      };
      const boom = new Error("sync failed");
      const error = await withRepoSyncLock(inst.pool, REPO, async () => {
        throw boom;
      }).catch((e: unknown) => e);
      expect(error).toBe(boom);
      await expectDestroyedAndRecovered(inst.calls[1]!.pid);
    });

    it("destroys the client when the unlock returns false", async () => {
      inst.intercept = async (c) => (c.step === "unlock" ? fakeRow({ unlocked: false }) : c.run());
      const result = await withRepoSyncLock(inst.pool, REPO, async () => "done");
      expect(result).toEqual({ acquired: true, value: "done" });
      await expectDestroyedAndRecovered(inst.calls[1]!.pid);
    });

    it("destroys the client when the unlock hits statement_timeout", async () => {
      inst.intercept = async (c) => {
        if (c.step !== "unlock") return c.run();
        await c.raw("set statement_timeout = 50");
        // pg_sleep comes first and is cancelled, so the unlock never runs and the lock stays held.
        return c.raw(
          "select pg_sleep(5)::text as slept, pg_advisory_unlock($1::bigint) as unlocked",
          [c.key],
        );
      };
      const result = await withRepoSyncLock(inst.pool, REPO, async () => "done");
      expect(result).toEqual({ acquired: true, value: "done" });
      // The unlock failed, so no result was recorded.
      expect(inst.calls[1]?.step).toBe("unlock");
      expect(inst.calls[1]?.result).toBeUndefined();
      await expectDestroyedAndRecovered(inst.calls[1]!.pid);
    });

    it("destroys the client when the acquire query fails after the lock was granted", async () => {
      inst.intercept = async (c) => {
        if (c.step !== "try") return c.run();
        // The server grants the lock, then the caller sees an error: the session may hold it.
        await c.run();
        throw new Error("injected acquire failure");
      };
      const fn = vi.fn(async () => 1);
      const error = await withRepoSyncLock(inst.pool, REPO, fn).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdvisoryLockError);
      expect((error as Error).message).toBe(
        "advisory lock: acquire failed, database error (unknown error)",
      );
      expect(fn).not.toHaveBeenCalled();
      await expectDestroyedAndRecovered(inst.calls[0]!.pid);
    });

    it("destroys a client that reported a connection error, even after a clean unlock", async () => {
      let client: PoolClient | undefined;
      inst.intercept = async (c) => {
        client = c.client;
        return c.run();
      };
      const result = await withRepoSyncLock(inst.pool, REPO, async ({ signal }) => {
        client!.emit("error", new Error("injected connection error"));
        return signal.aborted;
      });
      expect(result).toEqual({ acquired: true, value: true });
      expect(inst.calls[1]).toMatchObject({ step: "unlock", result: true });
      await expectDestroyedAndRecovered(inst.calls[1]!.pid);
    });
  });

  describe("abort around the acquire", () => {
    it("returns aborted when the abort lands while the try query is in flight", async () => {
      const controller = new AbortController();
      inst.intercept = async (c) => {
        if (c.step !== "try") return c.run();
        const pending = c.run();
        controller.abort();
        return pending;
      };
      const fn = vi.fn(async () => 1);
      const result = await withRepoSyncLock(inst.pool, REPO, fn, { signal: controller.signal });
      expect(result).toEqual({ acquired: false, reason: "aborted" });
      expect(fn).not.toHaveBeenCalled();
      // The lock was granted, then released cleanly: the client went back to the pool.
      expect(inst.calls.map((c) => [c.step, c.result])).toEqual([
        ["try", true],
        ["unlock", true],
      ]);
      expect(await advisoryLocks()).toBe(0);
      expect(inst.pool.totalCount).toBe(1);
    });

    it("returns aborted when the abort lands right after the lock is granted", async () => {
      const controller = new AbortController();
      inst.intercept = async (c) => {
        const res = await c.run();
        if (c.step === "try") controller.abort();
        return res;
      };
      const fn = vi.fn(async () => 1);
      const result = await withRepoSyncLock(inst.pool, REPO, fn, {
        signal: controller.signal,
        waitMs: 10_000,
      });
      expect(result).toEqual({ acquired: false, reason: "aborted" });
      expect(fn).not.toHaveBeenCalled();
      expect(await advisoryLocks()).toBe(0);
    });

    it("returns aborted, not a retry, when the abort lands during a busy try", async () => {
      const holder = await holdLock();
      const controller = new AbortController();
      inst.intercept = async (c) => {
        const pending = c.run();
        controller.abort();
        return pending;
      };
      const result = await withRepoSyncLock(inst.pool, REPO, async () => 1, {
        signal: controller.signal,
        waitMs: 10_000,
      });
      expect(result).toEqual({ acquired: false, reason: "aborted" });
      expect(tries()).toEqual([expect.objectContaining({ result: false })]);
      await holder.release();
    });
  });

  describe("wait mode", () => {
    it("acquires once the holder releases, after polling", async () => {
      const holder = await holdLock();
      let settled = false;
      const waiter = withRepoSyncLock(inst.pool, REPO, async () => "waiter", {
        waitMs: 30_000,
      }).finally(() => (settled = true));
      await vi.waitFor(() => expect(tries().length).toBeGreaterThanOrEqual(2));
      expect(settled).toBe(false);
      await holder.release();
      expect(await waiter).toEqual({ acquired: true, value: "waiter" });
    });

    it("tries before it sleeps, so it really contends with the holder", async () => {
      const holder = await holdLock();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const firstBusy = gate();
      inst.onResult = (c) => {
        if (c.step === "try" && c.result === false) firstBusy.open();
      };
      let settled = false;
      const waiter = withRepoSyncLock(inst.pool, REPO, async () => "waiter", {
        waitMs: 30_000,
      }).finally(() => (settled = true));
      // No fake timer has fired yet: a waiter that sleeps before its first try never gets here.
      await within(firstBusy.promise, 2_000, "first try");
      expect(settled).toBe(false);
      await holder.release();
      while (!settled) {
        await vi.advanceTimersByTimeAsync(250);
        await realDelay(5);
      }
      expect(await waiter).toEqual({ acquired: true, value: "waiter" });
      const results = tries().map((c) => c.result);
      expect(results[0]).toBe(false);
      expect(results.at(-1)).toBe(true);
    });

    it("returns aborted promptly when the signal fires during the sleep", async () => {
      const holder = await holdLock();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const firstBusy = gate();
      inst.onResult = (c) => {
        if (c.step === "try" && c.result === false) firstBusy.open();
      };
      const controller = new AbortController();
      const waiter = withRepoSyncLock(inst.pool, REPO, async () => "never", {
        waitMs: 60_000,
        signal: controller.signal,
      });
      await within(firstBusy.promise, 2_000, "first try");
      // Let the waiter return its client and start sleeping; the sleep timer is fake and never fires.
      await realDelay(20);
      const started = performance.now();
      controller.abort();
      expect(await within(waiter, 1_000, "aborted waiter")).toEqual({
        acquired: false,
        reason: "aborted",
      });
      expect(performance.now() - started).toBeLessThan(100);
      expect(tries()).toHaveLength(1);
      await holder.release();
    });

    it("polls with a bounded backoff, not a busy loop", async () => {
      const holder = await holdLock();
      const result = await withRepoSyncLock(inst.pool, REPO, async () => "never", {
        waitMs: 600,
      });
      expect(result).toEqual({ acquired: false, reason: "timeout" });
      // 20 ms doubling to 250 ms over 600 ms is about 7 tries; a 0 ms loop would make hundreds.
      expect(tries().length).toBeGreaterThanOrEqual(3);
      expect(tries().length).toBeLessThanOrEqual(15);
      expect(tries().every((c) => c.result === false)).toBe(true);
      await holder.release();
    });

    it("sleeps 20, 40, 80, 160 ms, then 250 ms at most, between busy tries", async () => {
      const holder = await holdLock();
      // A jitter factor of exactly 1, so the sleeps are the base delays.
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const timeouts = vi.spyOn(globalThis, "setTimeout");
      const controller = new AbortController();
      let sleeps: unknown[];
      try {
        const waiter = withRepoSyncLock(inst.pool, REPO, async () => "never", {
          waitMs: 30_000,
          signal: controller.signal,
        });
        await within(
          (async () => {
            while (tries().length < 8) await realDelay(10);
          })(),
          5_000,
          "eight tries",
        );
        controller.abort();
        expect(await waiter).toEqual({ acquired: false, reason: "aborted" });
        // The pool's own timers (idle and connect timeouts) are 10 s; the helper's sleeps are short.
        sleeps = timeouts.mock.calls
          .map((call) => call[1])
          .filter((ms) => typeof ms === "number" && ms < 1_000);
      } finally {
        controller.abort();
        vi.restoreAllMocks();
      }
      expect(sleeps.slice(0, 7)).toEqual([20, 40, 80, 160, 250, 250, 250]);
      await holder.release();
    });

    it("accepts an unbounded waitMs and stops on abort", async () => {
      const holder = await holdLock();
      const controller = new AbortController();
      const waiter = withRepoSyncLock(inst.pool, REPO, async () => "never", {
        waitMs: Number.POSITIVE_INFINITY,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(tries().length).toBeGreaterThanOrEqual(2));
      controller.abort();
      expect(await waiter).toEqual({ acquired: false, reason: "aborted" });
      await holder.release();
    });

    describe("on an exhausted pool", () => {
      let small: Instrumented;
      let blocker: PoolClient | undefined;

      beforeEach(async () => {
        small = instrument(t.url.reveal(), { max: 1, connectTimeoutMs: 400 });
        // The only connection is checked out, so the helper has to wait for one.
        blocker = await small.pool.connect();
      });

      afterEach(async () => {
        blocker?.release();
        blocker = undefined;
        await closeWithin(small, 2_000);
      });

      it("waits for a connection up to the pool's connect timeout, not waitMs", async () => {
        const started = performance.now();
        const error = await withRepoSyncLock(small.pool, REPO, async () => 1, {
          waitMs: 50,
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AdvisoryLockError);
        expect((error as Error).message).toBe(
          "advisory lock: cannot connect, database error (timeout)",
        );
        expect(performance.now() - started).toBeGreaterThanOrEqual(350);
        expect(small.calls).toHaveLength(0);
      });

      it.each([
        ["wait", { waitMs: 30_000 }],
        ["try", {}],
      ])(
        "returns aborted promptly when the signal fires while waiting for a connection (%s mode)",
        async (_mode, options) => {
          const controller = new AbortController();
          const waiter = withRepoSyncLock(small.pool, REPO, async () => "never", {
            ...options,
            signal: controller.signal,
          });
          await vi.waitFor(() => expect(small.pool.waitingCount).toBe(1));
          const started = performance.now();
          controller.abort();
          expect(await within(waiter, 200, "aborted waiter")).toEqual({
            acquired: false,
            reason: "aborted",
          });
          expect(performance.now() - started).toBeLessThan(100);
          expect(small.calls).toHaveLength(0);
          // The client that arrives later goes straight back to the pool.
          blocker?.release();
          blocker = undefined;
          await vi.waitFor(() => {
            expect(small.pool.waitingCount).toBe(0);
            expect(small.pool.totalCount - small.pool.idleCount).toBe(0);
          });
          expect(small.calls).toHaveLength(0);
          expect(await withRepoSyncLock(small.pool, REPO, async () => "next")).toEqual({
            acquired: true,
            value: "next",
          });
        },
      );
    });

    it("returns timeout while the holder keeps the lock", async () => {
      const result = await withRepoSyncLock(t.pool, REPO, async () => {
        const started = Date.now();
        const waited = await withRepoSyncLock(other.pool, REPO, async () => "never", {
          waitMs: 200,
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(190);
        return waited;
      });
      expect(result).toEqual({ acquired: true, value: { acquired: false, reason: "timeout" } });
    });

    it("returns aborted when the signal fires, without leaking the client", async () => {
      const holder = await holdLock();
      const controller = new AbortController();
      const waiter = withRepoSyncLock(inst.pool, REPO, async () => "never", {
        waitMs: 60_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(tries().length).toBeGreaterThanOrEqual(2));
      controller.abort();
      expect(await waiter).toEqual({ acquired: false, reason: "aborted" });
      await holder.release();
    });

    it("returns aborted at once for an already aborted signal", async () => {
      const fn = vi.fn(async () => 1);
      expect(await withRepoSyncLock(inst.pool, REPO, fn, { signal: AbortSignal.abort() })).toEqual({
        acquired: false,
        reason: "aborted",
      });
      expect(fn).not.toHaveBeenCalled();
      expect(inst.calls).toHaveLength(0);
    });

    it("forwards the caller's signal to the callback", async () => {
      const controller = new AbortController();
      const result = await withRepoSyncLock(
        t.pool,
        REPO,
        async ({ signal }) => {
          expect(signal.aborted).toBe(false);
          controller.abort();
          return signal.aborted;
        },
        { signal: controller.signal },
      );
      expect(result).toEqual({ acquired: true, value: true });
    });

    it(
      "does not let waiters starve the holder of pool connections",
      { timeout: 15_000 },
      async () => {
        // Pool max 4: the holder's lock client plus 3 waiters would fill it if waiters kept
        // their clients while sleeping, and the holder's own query would block until timeout.
        const pool = instrument(t.url.reveal(), { max: 4, connectTimeoutMs: 5_000 });
        const stop = new AbortController();
        let waiters: Promise<unknown>[] = [];
        try {
          const threeBusy = gate();
          let busy = 0;
          pool.onResult = (c) => {
            if (c.step === "try" && c.result === false && ++busy === 3) threeBusy.open();
          };
          let waitersSettled = 0;
          const holder = withRepoSyncLock(pool.pool, REPO, async () => {
            waiters = Array.from({ length: 3 }, (_, i) =>
              withRepoSyncLock(pool.pool, REPO, async () => `waiter ${i}`, {
                waitMs: 30_000,
                signal: stop.signal,
              }).finally(() => (waitersSettled += 1)),
            );
            await within(threeBusy.promise, 3_000, "three busy tries");
            const started = performance.now();
            await within(pool.pool.query("select 1"), 3_000, "holder's own query");
            // The holder's query finished while every waiter was still waiting.
            expect(waitersSettled).toBe(0);
            return performance.now() - started;
          });
          const held = await holder;
          expect(held.acquired).toBe(true);
          if (held.acquired) expect(held.value).toBeLessThan(2_000);
          // Once released, the waiters take the lock one after another.
          const results = await Promise.all(waiters);
          expect(results).toEqual([0, 1, 2].map((i) => ({ acquired: true, value: `waiter ${i}` })));
          expect(await advisoryLocks()).toBe(0);
          expect(pool.pool.totalCount - pool.pool.idleCount).toBe(0);
        } finally {
          stop.abort();
          await Promise.allSettled(waiters);
          await pool.close();
        }
      },
    );
  });

  describe("nested acquire of the same key", () => {
    // A nested call runs on another session, so it is not re-entrant: it is `busy` like any other
    // caller. On a pool with no spare connection it waits for one until the pool's connection
    // timeout and then throws, because the outer call holds the only client until it returns.
    it("is busy when the pool has a spare connection", async () => {
      const small = createDb(t.url.reveal(), { max: 2 });
      try {
        const result = await withRepoSyncLock(small.pool, REPO, async () =>
          withRepoSyncLock(small.pool, REPO, async () => "inner"),
        );
        expect(result).toEqual({ acquired: true, value: { acquired: false, reason: "busy" } });
      } finally {
        await small.close();
      }
    });

    it("throws a connection timeout on a pool of one, then releases the outer lock", async () => {
      const tiny = createDb(t.url.reveal(), { max: 1, connectTimeoutMs: 300 });
      try {
        const result = await withRepoSyncLock(tiny.pool, REPO, async () =>
          withRepoSyncLock(tiny.pool, REPO, async () => "inner").catch((e: unknown) => e),
        );
        expect(result.acquired).toBe(true);
        const inner = result.acquired ? result.value : undefined;
        expect(inner).toBeInstanceOf(AdvisoryLockError);
        expect((inner as Error).message).toBe(
          "advisory lock: cannot connect, database error (timeout)",
        );
        expect(await advisoryLocks()).toBe(0);
        expect(await withRepoSyncLock(tiny.pool, REPO, async () => "again")).toEqual({
          acquired: true,
          value: "again",
        });
      } finally {
        await tiny.close();
      }
    });
  });

  it("does not exhaust the pool over many sequential acquire/release cycles", async () => {
    const max = t.pool.options.max ?? 10;
    for (let i = 0; i < max * 10; i++) {
      const fail = i % 3 === 0;
      const outcome = await withRepoSyncLock(t.pool, REPO, async () => {
        if (fail) throw new Error("x");
        return i;
      }).catch(() => "threw");
      expect(outcome).toEqual(fail ? "threw" : { acquired: true, value: i });
    }
    expect(t.pool.totalCount).toBeLessThanOrEqual(max);
  });

  it("lets exactly one of 20 parallel callers win in try mode, repeatedly", async () => {
    for (let round = 0; round < 5; round++) {
      const losersDone = gate();
      let finished = 0;
      let running = 0;
      let maxRunning = 0;
      const callers = Array.from({ length: 20 }, () =>
        withRepoSyncLock(other.pool, REPO, async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          // Hold until every other caller has given up, so none can acquire after release.
          await losersDone.promise;
          running -= 1;
          return "won";
        }).then((r) => {
          if (!r.acquired && ++finished === 19) losersDone.open();
          return r;
        }),
      );
      let results: Awaited<(typeof callers)[number]>[];
      try {
        results = await Promise.all(callers);
      } finally {
        // If a caller threw, the winner would wait forever and keep its lock client: free it.
        losersDone.open();
        await Promise.allSettled(callers);
      }
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      expect(results.filter((r) => !r.acquired && r.reason === "busy")).toHaveLength(19);
      expect(maxRunning).toBe(1);
      expect(await advisoryLocks()).toBe(0);
    }
  });
});
