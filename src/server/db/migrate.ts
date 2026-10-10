import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { DATABASE_URL_VAR, parseDatabaseUrl, type EnvSource } from "../config/env";
import { createDb, describeDbError, type DbHandle } from "./client";

export interface MigrateResult {
  /** Migrations applied by this run. */
  applied: number;
  /** Migrations recorded in the database after this run. */
  total: number;
}

/** Thrown by `migrateDatabase`; the message names the variable and holds no connection detail. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export const MIGRATIONS_DIR_VAR = "MIGRATIONS_DIR";

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

/**
 * Migration entry: validates `DATABASE_URL` and the migrations folder, migrates, and always closes
 * the pool. Failures become a `MigrationError` carrying a variable name, an error code and, for a
 * failing statement, the migration file name; never the URL or the statement.
 *
 * Drizzle's migrator runs all pending migrations in ONE transaction: when one fails, the earlier
 * ones of the same run are rolled back too and none is recorded as applied.
 */
export async function migrateDatabase(
  env: EnvSource,
  folder: string,
  options: { connectTimeoutMs?: number } = {},
): Promise<MigrateResult> {
  const checked = parseDatabaseUrl(env);
  if (checked.url === null) throw new MigrationError(checked.problems.join("; "));
  const found = preflight(folder);

  const handle = createDb(checked.url.reveal(), { max: 1, ...options });
  try {
    return await runMigrations(handle, folder);
  } catch (error) {
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
