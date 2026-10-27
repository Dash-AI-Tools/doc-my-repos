import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { describeDbError } from "./client";

/**
 * Postgres session-level advisory locks, used to serialize work that must not overlap, such as
 * two syncs of the same repository.
 *
 * A session-level lock belongs to one connection, so a held lock keeps a dedicated client from the
 * pool until the callback settles. Two hazards follow:
 *
 * - Pool capacity: a holder occupies one pool connection for the lock, on top of the connections
 *   the callback itself uses. A wait-mode waiter only holds a connection during each attempt and
 *   gives it back before sleeping, so waiters cannot starve the holder they wait on.
 * - Pooling proxies: session-level locks do not work through a transaction-pooling proxy such as
 *   PgBouncer in transaction mode, which can hand the session to another client between
 *   statements. Connect directly to Postgres, or through a proxy in session mode.
 *
 * If the lock's connection dies (crash, network loss, `pg_terminate_backend`), Postgres frees the
 * lock by itself. A connection that may still hold a lock is never returned to the pool: when an
 * acquire or unlock query fails, the unlock reports that nothing was held, or the connection
 * reported an error, the client is destroyed, which ends the session and frees any lock it held.
 *
 * Waiting for a pool connection is bounded by the pool's own connection timeout, not by `waitMs`:
 * on an exhausted pool an attempt waits up to `connectionTimeoutMillis` and then throws
 * `AdvisoryLockError` ("cannot connect"), even when `waitMs` is shorter. The caller's signal does
 * end that wait (`aborted`); a client that arrives after the abort goes straight back to the pool.
 *
 * Cancellation is cooperative only. Once the callback runs, aborting the caller's signal only
 * aborts `LockContext.signal`; the lock is released when the callback settles, so a callback that
 * ignores the signal and never settles holds the lock (and its connection) forever.
 */

/** Namespace for per-repository sync locks. Other uses take their own namespace. */
export const REPO_SYNC_LOCK_NAMESPACE = "docmyrepos:repo-sync";

/** Base poll delay in wait mode: 20 ms on the first busy attempt, doubling up to 250 ms. */
const FIRST_POLL_MS = 20;
const MAX_POLL_MS = 250;
/** Each sleep is the base delay scaled by a random factor in [1 - JITTER, 1 + JITTER). */
const JITTER = 0.2;

/** Largest Postgres `bigint`, the column type of `repos.github_id`. */
const MAX_BIGINT = 2n ** 63n - 1n;

/** A fixed-message error. It never carries the driver error, whose text can name the host or user. */
export class AdvisoryLockError extends Error {
  override name = "AdvisoryLockError";
}

export type LockResult<T> =
  { acquired: true; value: T } | { acquired: false; reason: "busy" | "timeout" | "aborted" };

export interface LockOptions {
  /**
   * How long to keep trying, in milliseconds. Omitted or 0: try once and return `busy` if another
   * session holds the lock. Positive (`Infinity` allowed): retry until acquired, `timeout`, or
   * `aborted`. Anything but a number >= 0 (NaN, negative) rejects with an `AdvisoryLockError`. It
   * does not bound the wait for a pool connection (see the module comment).
   */
  waitMs?: number;
  /**
   * Stops waiting for the lock or a pool connection (`aborted`), and is forwarded to the callback
   * through `LockContext.signal`. It does not stop a running callback (cancellation is cooperative).
   */
  signal?: AbortSignal;
}

export interface LockContext {
  /**
   * Aborts when the caller's signal aborts or when the lock's connection is lost. After a lost
   * connection the lock is no longer held, so long-running work should check this and stop. The
   * result is still `acquired: true` in that case: this signal is the only report of the loss.
   */
  readonly signal: AbortSignal;
}

/** The identity of a repository sync lock: GitHub's numeric repository id. */
export interface RepoLockIdentity {
  /** A positive integer, as a number, bigint or decimal string. Stable across renames and transfers. */
  githubId: number | bigint | string;
}

/**
 * A deterministic signed 64-bit advisory-lock key, as a decimal string for a `bigint` parameter:
 * the first 8 bytes of SHA-256 over `namespace`, a NUL separator and `identity`. Computed in JS so
 * it does not depend on Postgres hash functions. `namespace` must not contain NUL, so the hash
 * input is unambiguous and two namespaces can never produce the same input.
 */
export function advisoryLockKey(namespace: string, identity: string): string {
  if (namespace.includes("\0")) {
    throw new AdvisoryLockError("advisory lock: namespace must not contain a NUL character");
  }
  const digest = createHash("sha256").update(`${namespace}\0${identity}`).digest();
  return digest.readBigInt64BE(0).toString();
}

/**
 * The lock key for syncing the repository with GitHub id `githubId`. The id, unlike `owner/name`,
 * survives renames and transfers, so a rename during a running sync cannot let a second sync of the
 * same repository start. Throws a fixed-message `AdvisoryLockError` for anything but a positive
 * integer that fits a Postgres `bigint`.
 */
export function repoSyncLockKey(repo: RepoLockIdentity): string {
  return advisoryLockKey(REPO_SYNC_LOCK_NAMESPACE, canonicalGithubId(repo.githubId));
}

function canonicalGithubId(id: unknown): string {
  let n: bigint | undefined;
  if (typeof id === "number" && Number.isSafeInteger(id)) n = BigInt(id);
  else if (typeof id === "bigint") n = id;
  else if (typeof id === "string" && /^[0-9]{1,19}$/.test(id)) n = BigInt(id);
  if (n === undefined || n < 1n || n > MAX_BIGINT) {
    throw new AdvisoryLockError("advisory lock: githubId must be a positive integer");
  }
  return n.toString();
}

/**
 * Runs `fn` while holding the session-level advisory lock `key` (a signed 64-bit integer as a
 * decimal string). Returns `{ acquired: false, reason }` without running `fn` when the lock is
 * held elsewhere (`busy` in try mode, `timeout` or `aborted` in wait mode), or `aborted` when the
 * signal fires before `fn` starts, even if the lock was just taken (it is released again).
 *
 * The lock is released when `fn` returns or throws; an error thrown by `fn` reaches the caller
 * unchanged. A failed unlock is not reported to the caller: the client is destroyed instead, which
 * ends the session and so frees the lock. Failures to connect or to run the acquire query throw an
 * `AdvisoryLockError` with a fixed message.
 *
 * A held lock keeps one pool client. In wait mode each attempt checks out a client and returns it
 * before sleeping, so a waiter holds a connection only while it asks. Sleeps follow
 * `pollDelayMs`, with jitter so many waiters do not retry in lockstep. A nested call for a key the
 * caller already holds runs on another session, so it is `busy` (or waits) like any other caller,
 * and on an exhausted pool it waits for a connection up to the pool's connection timeout.
 *
 * Aborting the signal while `fn` runs does not release the lock: `fn` must watch
 * `LockContext.signal` and settle. A callback that never settles holds the lock forever.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: string,
  fn: (context: LockContext) => Promise<T>,
  options: LockOptions = {},
): Promise<LockResult<T>> {
  const { signal } = options;
  const waitMs: unknown = options.waitMs === undefined ? 0 : options.waitMs;
  if (typeof waitMs !== "number" || Number.isNaN(waitMs) || waitMs < 0) {
    throw new AdvisoryLockError("advisory lock: waitMs must be a number >= 0");
  }
  const deadline = Date.now() + waitMs;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return { acquired: false, reason: "aborted" };
    const lease = await tryAcquire(pool, key, signal);
    if (lease) return runHolding(lease, key, fn, signal);
    if (signal?.aborted) return { acquired: false, reason: "aborted" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { acquired: false, reason: waitMs > 0 ? "timeout" : "busy" };
    await sleep(Math.min(pollDelayMs(attempt), remaining), signal);
  }
}

/**
 * The sleep after busy attempt `attempt` (0-based) in wait mode: a base delay of 20 ms doubling
 * per attempt up to a 250 ms cap, then scaled by a jitter factor in [0.8, 1.2) drawn from
 * `random` (a `Math.random`-like function). The cap applies before jitter, so a sleep is always
 * within 16 ms to 300 ms. Exported for tests.
 */
export function pollDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(FIRST_POLL_MS * 2 ** Math.min(attempt, 16), MAX_POLL_MS);
  return base * (1 - JITTER + 2 * JITTER * random());
}

/**
 * Runs `fn` while holding the sync lock for one repository, so syncs of it never overlap, whether
 * they come from this process or another one. Keyed on the GitHub repository id, so it works
 * before the `repos` row exists and across renames. An invalid id rejects with the fixed message of
 * `repoSyncLockKey`. See `withAdvisoryLock` for result and options.
 */
export async function withRepoSyncLock<T>(
  pool: Pool,
  repo: RepoLockIdentity,
  fn: (context: LockContext) => Promise<T>,
  options?: LockOptions,
): Promise<LockResult<T>> {
  return withAdvisoryLock(pool, repoSyncLockKey(repo), fn, options);
}

/** A checked-out client that holds the lock, with its connection-loss tracking. */
interface Lease {
  readonly client: PoolClient;
  /** Aborts when the connection reports an error or ends. */
  readonly lost: AbortSignal;
  /** Returns the client to the pool, or destroys it when `destroy` is set or the connection was lost. */
  readonly release: (destroy: boolean) => void;
}

/**
 * One attempt: a client holding the lock, or null (client already returned) when it is busy or
 * `signal` aborted while waiting for a connection.
 */
async function tryAcquire(
  pool: Pool,
  key: string,
  signal: AbortSignal | undefined,
): Promise<Lease | null> {
  let client: PoolClient | null;
  try {
    client = await connect(pool, signal);
  } catch (error) {
    throw new AdvisoryLockError(`advisory lock: cannot connect, ${describeDbError(error)}`);
  }
  if (client === null) return null;

  // A checked-out client has no error listener; an unhandled 'error' would crash the process.
  const lost = new AbortController();
  const onConnectionLost = () => lost.abort();
  client.on("error", onConnectionLost);
  client.on("end", onConnectionLost);
  const release = (destroy: boolean) => {
    client.off("error", onConnectionLost);
    client.off("end", onConnectionLost);
    client.release(destroy || lost.signal.aborted ? new Error("advisory lock client") : undefined);
  };

  let acquired: boolean;
  try {
    const res = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as acquired",
      [key],
    );
    acquired = res.rows[0]?.acquired === true;
  } catch (error) {
    // The lock may have been granted before the failure: never pool this session.
    release(true);
    throw new AdvisoryLockError(`advisory lock: acquire failed, ${describeDbError(error)}`);
  }
  if (!acquired) {
    // Not granted, and a pooled session never holds a lock, so the client is clean.
    release(false);
    return null;
  }
  return { client, lost: lost.signal, release };
}

/** Runs `fn` on a held lease, then unlocks; destroys the client if the unlock is not clean. */
async function runHolding<T>(
  lease: Lease,
  key: string,
  fn: (context: LockContext) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<LockResult<T>> {
  try {
    if (signal?.aborted) return { acquired: false, reason: "aborted" };
    const contextSignal = signal ? AbortSignal.any([signal, lease.lost]) : lease.lost;
    return { acquired: true, value: await fn({ signal: contextSignal }) };
  } finally {
    const clean = await unlock(lease.client, key);
    lease.release(!clean);
  }
}

/** True only when the unlock ran and reports that this session held the lock. */
async function unlock(client: PoolClient, key: string): Promise<boolean> {
  try {
    const res = await client.query<{ unlocked: boolean }>(
      "select pg_advisory_unlock($1::bigint) as unlocked",
      [key],
    );
    return res.rows[0]?.unlocked === true;
  } catch {
    return false;
  }
}

/**
 * A pool client, or null as soon as `signal` aborts. A client that arrives after the abort has run
 * no query, so it goes straight back to the pool; a later connect error is ignored.
 */
function connect(pool: Pool, signal: AbortSignal | undefined): Promise<PoolClient | null> {
  const pending = pool.connect();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.then(
        (late) => late.release(),
        () => undefined,
      );
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    pending.then(
      (client) => {
        signal.removeEventListener("abort", onAbort);
        resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
