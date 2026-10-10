import "server-only";

import { loadConfig, type LoadConfigOptions, type LoadedConfig } from "./config/load";
import { closeDb, createDb, getDb, redactWhenLogged, type DbHandle } from "./db/client";
import { createInstallationTokenProvider } from "./github/app-auth";
import { createGitHubClient, type GitHubClient } from "./github/client";
import { createSyncContext, type SyncContext, type SyncTuning } from "./sync/engine";

/**
 * The server runtime: config, database, GitHub client and sync context, built once from
 * `loadConfig` and the environment. This is where config loading is wired in for server entry
 * points (route handlers in 6.x call `getRuntime()`).
 *
 * - No side effects at import time: nothing is read, connected or minted until `getRuntime()` or
 *   `createRuntime()` is called. The database pool connects on its first query and the token
 *   provider mints on the first GitHub request.
 * - A configuration problem throws `ConfigError`, whose text names variables and fields but never
 *   holds a value. A failed build is not cached, so a fixed environment is picked up on retry.
 * - Secrets stay wrapped: the private key is revealed only inside the token provider, the database
 *   URL only to the pool. The runtime object prints as `[redacted]`. Nothing here logs.
 */

export interface RuntimeOptions extends LoadConfigOptions {
  /** `fetch` for GitHub (API and token minting). Defaults to the global one. */
  fetch?: typeof fetch;
  /** Builds the database handle from the validated URL. Default: a new pool (`createDb`). */
  createDb?: (databaseUrl: string) => DbHandle;
  tuning?: SyncTuning;
}

export interface Runtime {
  readonly loaded: LoadedConfig;
  readonly db: DbHandle;
  readonly github: GitHubClient;
  readonly sync: SyncContext;
  /** Closes the database handle. */
  close(): Promise<void>;
}

/** Builds a runtime. Throws `ConfigError` (no secret values) when config or environment is invalid. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const loaded = loadConfig({ env: options.env, readFile: options.readFile, cwd: options.cwd });
  const { env } = loaded;
  const db = (options.createDb ?? ((url: string) => createDb(url)))(env.databaseUrl.reveal());
  const tokens = createInstallationTokenProvider({
    appId: env.githubAppId,
    installationId: env.githubAppInstallationId,
    privateKey: env.githubAppPrivateKey,
    fetch: options.fetch,
  });
  const github = createGitHubClient({ getToken: tokens.getToken, fetch: options.fetch });
  const sync = createSyncContext({
    db: db.db,
    pool: db.pool,
    github,
    config: loaded.config,
    tuning: options.tuning,
  });
  return Object.freeze(redactWhenLogged({ loaded, db, github, sync, close: () => db.close() }));
}

const CACHE_KEY = Symbol.for("docmyrepos.runtime");
type Cache = { [CACHE_KEY]?: Runtime };

/**
 * The shared runtime, built on first call from `process.env` (or `options`, used only on that
 * first build) and cached on `globalThis` so Next.js dev reloads reuse it. By default it shares
 * the database handle of `getDb()`, so pages and syncs use one pool.
 */
export function getRuntime(options: RuntimeOptions = {}): Runtime {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= createRuntime({ createDb: () => getDb(), ...options });
  return cache[CACHE_KEY];
}

/**
 * Re-reads `docmyrepos.config.yml` and the environment and replaces the shared runtime (design:
 * config is re-read on `/api/sync`, so a config edit applies without a restart). The database
 * handle is kept: the new runtime shares the previous runtime's pool (or `getDb()` when there was
 * none), so no connection is closed or reopened, and a sync that is already running keeps the
 * runtime it started with. `DATABASE_URL` changes therefore need a restart. The GitHub client and
 * token provider are rebuilt, so the next request mints a fresh installation token.
 *
 * When the configuration is invalid this throws `ConfigError` (variable and field names only) and
 * leaves the previous runtime in place, so a bad edit never takes down a working one.
 */
export function reloadRuntime(options: RuntimeOptions = {}): Runtime {
  const cache = globalThis as Cache;
  const previous = cache[CACHE_KEY];
  const next = createRuntime({ createDb: () => previous?.db ?? getDb(), ...options });
  cache[CACHE_KEY] = next;
  return next;
}

/** Drops the shared runtime and closes its database handle (and the shared `getDb()` handle). */
export async function closeRuntime(): Promise<void> {
  const cache = globalThis as Cache;
  const runtime = cache[CACHE_KEY];
  delete cache[CACHE_KEY];
  await runtime?.close();
  await closeDb();
}
