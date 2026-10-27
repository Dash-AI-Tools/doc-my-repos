import { describeDbError } from "./client";

/**
 * Waiting for a database that is still starting (task 13.1). The container entrypoint runs the
 * migrations on start; with Docker Compose the database may need a few more seconds, and with a
 * managed database a restart can take longer. The helpers here are pure so they are unit tested
 * without a database: `scripts/db-migrate.ts` wires them to a real connection.
 */

/** Longest wait `DB_WAIT_SECONDS` may ask for. */
export const MAX_WAIT_SECONDS = 600;

/** Default pause between two connection attempts. */
export const DEFAULT_WAIT_INTERVAL_MS = 2_000;

/** OS error codes that mean "nothing is listening yet" or "the network is not ready". */
const TRANSIENT_OS_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * SQLSTATEs that mean "try again": the server is starting up or shutting down (57P01, 57P02,
 * 57P03), has no free connection slot (53300), or the connection broke (class 08).
 */
function isTransientSqlState(code: string): boolean {
  return (
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "53300" ||
    code.startsWith("08")
  );
}

/**
 * True when `error` is a connection problem that can go away by itself: refused, reset, timed out,
 * name not resolved yet, or a server that is starting up. A wrong password (28P01), a missing
 * database (3D000) and every other error are NOT transient, so a misconfiguration fails at once
 * instead of after the whole wait. Only the fixed description from `describeDbError` is read.
 */
export function isTransientConnectionError(error: unknown): boolean {
  const description = describeDbError(error);
  const code = /^database error \((.+)\)$/.exec(description)?.[1];
  if (code === undefined) return false;
  if (code === "timeout") return true;
  return TRANSIENT_OS_CODES.has(code) || isTransientSqlState(code);
}

export type WaitResult =
  { ready: true; attempts: number } | { ready: false; attempts: number; lastError: unknown };

export interface WaitOptions {
  /** Give up after this long. 0: one attempt only. */
  timeoutMs: number;
  /** Pause between attempts (default 2 s). */
  intervalMs?: number;
  /** Called after each failed transient attempt that will be retried. */
  onRetry?: (info: { attempt: number; elapsedMs: number; error: unknown }) => void;
  /** Clock and sleep, replaced in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Calls `ping` until it resolves or `timeoutMs` has passed. A non-transient error ends the wait at
 * once (`ready: false` with that error); a transient one is retried every `intervalMs`. Always
 * makes at least one attempt, and never sleeps past the deadline.
 */
export async function waitUntilReady(
  ping: () => Promise<unknown>,
  options: WaitOptions,
): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const start = now();
  const deadline = start + Math.max(0, options.timeoutMs);

  for (let attempt = 1; ; attempt++) {
    try {
      await ping();
      return { ready: true, attempts: attempt };
    } catch (error) {
      if (!isTransientConnectionError(error))
        return { ready: false, attempts: attempt, lastError: error };
      const remaining = deadline - now();
      if (remaining <= 0) return { ready: false, attempts: attempt, lastError: error };
      options.onRetry?.({ attempt, elapsedMs: now() - start, error });
      await sleep(Math.min(interval, remaining));
    }
  }
}

export type WaitSecondsResult = { ok: true; seconds: number } | { ok: false; problem: string };

/**
 * Parses `DB_WAIT_SECONDS`: unset or blank means 0 (no waiting, the `pnpm db:migrate` default); a
 * whole number from 0 to `MAX_WAIT_SECONDS` otherwise. The problem text never echoes the value.
 */
export function parseWaitSeconds(value: string | undefined): WaitSecondsResult {
  const text = value?.trim() ?? "";
  if (text === "") return { ok: true, seconds: 0 };
  if (!/^[0-9]{1,4}$/.test(text) || Number(text) > MAX_WAIT_SECONDS) {
    return {
      ok: false,
      problem: `DB_WAIT_SECONDS: must be a whole number of seconds from 0 to ${MAX_WAIT_SECONDS}`,
    };
  }
  return { ok: true, seconds: Number(text) };
}
