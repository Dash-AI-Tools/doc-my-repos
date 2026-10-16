import { inspect } from "node:util";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { parseDatabaseUrl } from "../config/env";
import { ConfigError } from "../config/errors";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Db;
  readonly pool: Pool;
  /** Ends the pool. Safe to call more than once. */
  close(): Promise<void>;
}

const REDACTED = "[redacted]";

/** Default time to wait for a connection before giving up. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Makes `target` print as `[redacted]` under `util.inspect` (any options), `console.log`,
 * `util.format`, `String()` and `JSON.stringify`. node-postgres keeps the connection string in
 * `pool.options`, so a logged pool or Drizzle instance would otherwise show the password. The
 * properties are own, non-enumerable and non-writable, so Drizzle and the pool work unchanged and
 * an object spread does not copy them (re-apply to a spread copy).
 */
export function redactWhenLogged<T extends object>(target: T): T {
  const hide = () => REDACTED;
  for (const key of [inspect.custom, "toJSON", "toString"]) {
    Object.defineProperty(target, key, { value: hide, enumerable: false, configurable: true });
  }
  return target;
}

const TIMEOUT_MESSAGES = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
]);

/**
 * A short, fixed description of a database error: the SQLSTATE, OS code or `timeout` only. Driver
 * messages can name the user, host or address, so they are never reported. Every error from
 * `db.execute()` and friends can carry such detail: query code must report failures through this
 * function and never log or return the raw error.
 */
export function describeDbError(error: unknown): string {
  // Drizzle wraps driver errors and keeps the original in `cause`.
  for (
    let e: unknown = error, depth = 0;
    typeof e === "object" && e !== null && depth < 4;
    depth++
  ) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{2,}$/.test(code)) return `database error (${code})`;
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && TIMEOUT_MESSAGES.has(message))
      return "database error (timeout)";
    e = (e as { cause?: unknown }).cause;
  }
  return "database error (unknown error)";
}

/**
 * Opens a pool for `url` and binds Drizzle to the schema. Nothing connects until the first query.
 * Throws a fixed message, never the URL, when the URL is not a Postgres URL. A connection attempt
 * fails after `connectTimeoutMs` (default 10 s) instead of hanging on an unreachable host. The
 * handle, its `pool` and its `db` print as `[redacted]` when logged.
 */
export function createDb(
  url: string,
  options: { max?: number; connectTimeoutMs?: number } = {},
): DbHandle {
  // Same validation as the app config; also keeps node-postgres from parsing a malformed URL,
  // whose parse errors carry the input.
  const checked = parseDatabaseUrl({ DATABASE_URL: url });
  if (checked.url === null) throw new Error(checked.problems.join("; "));

  const pool = redactWhenLogged(
    new Pool({
      connectionString: checked.url.reveal(),
      max: options.max,
      connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    }),
  );
  // An idle client that loses its connection emits 'error'; without a listener that would crash
  // the process. The next query on the pool reports the failure to its caller instead.
  pool.on("error", () => undefined);
  const db = redactWhenLogged(drizzle(pool, { schema }));

  let closing: Promise<void> | undefined;
  return redactWhenLogged({
    db,
    pool,
    close: () => (closing ??= pool.end()),
  });
}

const CACHE_KEY = Symbol.for("docmyrepos.db");
type Cache = { [CACHE_KEY]?: DbHandle };

/**
 * The shared database handle, created on first use from `DATABASE_URL`. Never called at import
 * time. Cached on `globalThis` so Next.js dev reloads reuse it. Throws `ConfigError` (variable name
 * only) when `DATABASE_URL` is missing or invalid.
 */
export function getDb(env: Readonly<Record<string, string | undefined>> = process.env): DbHandle {
  const cache = globalThis as Cache;
  if (cache[CACHE_KEY] === undefined) {
    const parsed = parseDatabaseUrl(env);
    if (parsed.url === null) throw new ConfigError(parsed.problems);
    cache[CACHE_KEY] = createDb(parsed.url.reveal());
  }
  return cache[CACHE_KEY];
}

/** Closes the shared handle, if one was created, so scripts and tests can exit. */
export async function closeDb(): Promise<void> {
  const cache = globalThis as Cache;
  const handle = cache[CACHE_KEY];
  delete cache[CACHE_KEY];
  await handle?.close();
}
