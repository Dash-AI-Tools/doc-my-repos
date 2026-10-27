import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { DATABASE_URL_VAR, parseDatabaseUrl, type EnvSource } from "../config/env";
import { AdvisoryLockError, advisoryLockKey, withAdvisoryLock } from "./advisory-lock";
import { createDb, describeDbError, type DbHandle } from "./client";
import {
  migratePlugin,
  PluginMigrationError,
  type PluginMigrateResult,
  type PluginMigrations,
} from "./plugin-migrations";
import { waitUntilReady, type WaitOptions } from "./wait";

export interface MigrateResult {
  /** Migrations applied by this run. */
  applied: number;
  /** Migrations recorded in the database after this run. */
  total: number;
  /** Each plugin's own counts, when plugins were given. */
  plugins?: Readonly<Record<string, PluginMigrateResult>>;
}

/** Thrown by `migrateDatabase`; the message names the variable and holds no connection detail. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export const MIGRATIONS_DIR_VAR = "MIGRATIONS_DIR";

/**
 * Advisory-lock key that serializes migration runs. Drizzle's migrator takes no lock, so two
 * containers starting together would race on the bookkeeping table and the loser would fail with an
 * opaque unique violation. Under this lock the second run waits, then finds nothing left to apply.
 * Its own namespace cannot collide with repo sync keys.
 */
export const MIGRATION_LOCK_NAMESPACE = "docmyrepos:migrate";
export const MIGRATION_LOCK_KEY = advisoryLockKey(MIGRATION_LOCK_NAMESPACE, "schema");

/** How long a run waits for another run's lock before giving up. Migrations take seconds. */
export const DEFAULT_LOCK_WAIT_MS = 120_000;

interface Preflight {
  /** Journal tags in order; `statements[i]` are the SQL statements of `tags[i]`. */
  tags: string[];
  statements: string[][];
}

/** The folder as a short relative name for messages (no secrets, no absolute path). */
function shortName(folder: string): string {
  const rel = relative(process.cwd(), folder);
  // Outside the working directory the relative form is a noisy ../../ chain; use the last segment.
  return rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? basename(folder) : rel;
}

/** Checks the migrations folder and journal before any connection is made. */
function preflight(folder: string): Preflight {
  const name = shortName(folder);
  const journalPath = join(folder, "meta", "_journal.json");
  if (!existsSync(folder)) {
    throw new MigrationError(
      `${MIGRATIONS_DIR_VAR}: migrations folder "${name}" not found; set ${MIGRATIONS_DIR_VAR} or run from the repository root`,
    );
  }
  if (!existsSync(journalPath)) {
    throw new MigrationError(
      `${MIGRATIONS_DIR_VAR}: "${join(name, "meta", "_journal.json")}" not found; this is not a migrations folder`,
    );
  }
  try {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const files = readMigrationFiles({ migrationsFolder: folder });
    return { tags: journal.entries.map((e) => e.tag), statements: files.map((f) => f.sql) };
  } catch {
    // Parser and fs errors name paths and may quote content; report a fixed message.
    throw new MigrationError(
      `${MIGRATIONS_DIR_VAR}: the journal in "${name}" is invalid or lists a migration file that cannot be read`,
    );
  }
}

/**
 * Finds the migration file whose statement failed, by matching the statement carried on the
 * Drizzle error against the files' statements. Only the file name (journal tag) is returned,
 * never the statement.
 */
function failingMigrationFile(error: unknown, found: Preflight): string | undefined {
  for (
    let e: unknown = error, depth = 0;
    typeof e === "object" && e !== null && depth < 4;
    depth++
  ) {
    const query = (e as { query?: unknown }).query;
    if (typeof query === "string") {
      const index = found.statements.findIndex((list) => list.includes(query));
      const tag = found.tags[index];
      return tag !== undefined && /^[\w.-]+$/.test(tag) ? `${tag}.sql` : undefined;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

async function appliedCount({ pool }: DbHandle): Promise<number> {
  // Postgres resolves table names at parse time, so the existence check must be its own query.
  const exists = await pool.query<{ found: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS found",
  );
  if (!exists.rows[0]?.found) return 0;
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  return rows[0]?.n ?? 0;
}

/**
 * Applies the migrations in `folder` in journal order with drizzle-orm's migrator. Idempotent:
 * migrations already recorded are skipped. Errors from Postgres propagate as thrown.
 */
export async function runMigrations(handle: DbHandle, folder: string): Promise<MigrateResult> {
  const before = await appliedCount(handle);
  await migrate(handle.db, { migrationsFolder: folder });
  const total = await appliedCount(handle);
  return { applied: total - before, total };
}

export interface MigrateOptions {
  connectTimeoutMs?: number;
  /**
   * Wait up to this long for the database to accept connections before migrating (it may still be
   * starting). Only connection problems that can go away are retried. Default 0: no waiting.
   */
  waitForDatabaseMs?: number;
  waitIntervalMs?: number;
  onWait?: WaitOptions["onRetry"];
  /** How long to wait for a concurrent migration run to finish. Default `DEFAULT_LOCK_WAIT_MS`. */
  lockWaitMs?: number;
  /** Plugins whose migrations run after the core's, each in its own schema (plugin-api). */
  plugins?: readonly PluginMigrations[];
}

/**
 * Migration entry: validates `DATABASE_URL` and the migrations folder, optionally waits for the
 * database, migrates under a cluster-wide advisory lock, and always closes the pool. Failures
 * become a `MigrationError` carrying a variable name, an error code and, for a failing statement,
 * the migration file name; never the URL or the statement.
 *
 * Several processes may call this at once (replicas starting together): they take turns, so every
 * one exits successfully and only the first reports applied migrations. The lock is a session
 * lock, so connect directly to Postgres or through a proxy in session mode (not PgBouncer in
 * transaction mode).
 *
 * Drizzle's migrator runs all pending migrations in ONE transaction: when one fails, the earlier
 * ones of the same run are rolled back too and none is recorded as applied.
 */
export async function migrateDatabase(
  env: EnvSource,
  folder: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const checked = parseDatabaseUrl(env);
  if (checked.url === null) throw new MigrationError(checked.problems.join("; "));
  const found = preflight(folder);

  // Two connections: one holds the lock, the other runs the migrations.
  const handle = createDb(checked.url.reveal(), {
    max: 2,
    connectTimeoutMs: options.connectTimeoutMs,
  });
  try {
    // Always one connection check first, so an unreachable database or a wrong password reports
    // "not reachable" rather than a lock error; `waitForDatabaseMs` adds retries for a database
    // that is still starting.
    const waited = await waitUntilReady(() => handle.pool.query("select 1"), {
      timeoutMs: options.waitForDatabaseMs ?? 0,
      intervalMs: options.waitIntervalMs,
      onRetry: options.onWait,
    });
    if (!waited.ready) {
      throw new MigrationError(
        `${DATABASE_URL_VAR}: database not reachable after ${waited.attempts} attempt${waited.attempts === 1 ? "" : "s"}, ${describeDbError(waited.lastError)}`,
      );
    }
    const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    const locked = await withAdvisoryLock(
      handle.pool,
      MIGRATION_LOCK_KEY,
      async () => {
        const core = await runMigrations(handle, folder);
        if (options.plugins === undefined) return core;
        const plugins: Record<string, PluginMigrateResult> = {};
        for (const plugin of options.plugins) {
          plugins[plugin.id] = await migratePlugin(handle.pool, plugin);
        }
        return { ...core, plugins };
      },
      { waitMs: lockWaitMs },
    );
    if (!locked.acquired) {
      throw new MigrationError(
        `another migration run holds the lock (${locked.reason}); gave up after ${Math.round(lockWaitMs / 1000)} s`,
      );
    }
    return locked.value;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (error instanceof PluginMigrationError) throw new MigrationError(error.message);
    // Fixed message, no connection detail (see AdvisoryLockError).
    if (error instanceof AdvisoryLockError) {
      throw new MigrationError(`${DATABASE_URL_VAR}: ${error.message}`);
    }
    const file = failingMigrationFile(error, found);
    throw new MigrationError(
      file === undefined
        ? `${DATABASE_URL_VAR}: migration failed, ${describeDbError(error)}`
        : `migration ${file} failed, ${describeDbError(error)}`,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}
