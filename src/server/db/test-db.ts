import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { describe } from "vitest";

import { Secret } from "../config/secret";
import { createDb, describeDbError, redactWhenLogged, type DbHandle } from "./client";
import { runMigrations } from "./migrate";

/** Same credentials and port as `docker compose --env-file .env.example up -d db`. */
const DEFAULT_TEST_SERVER_URL = "postgres://docmyrepos:docmyrepos@127.0.0.1:5432/docmyrepos";

/** Shorter than the app default: a test server is local, so a slow connect means it is down. */
const CONNECT_TIMEOUT_MS = 5_000;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const UNREACHABLE_HELP =
  "Start it with `docker compose --env-file .env.example up -d db`, point TEST_DATABASE_URL at a " +
  "reachable Postgres server, or set SKIP_DB_TESTS=1 to skip the database tests.";

export interface TestDatabase extends DbHandle {
  /** Connection URL of the throwaway database. Wrapped so it cannot be logged by accident. */
  readonly url: Secret<string>;
  /** Closes the pool and drops the database, even if other connections are still open. */
  drop(): Promise<void>;
}

/** True when `SKIP_DB_TESTS=1`: the opt-out for machines without a Postgres server. */
export const skipDbTests = process.env.SKIP_DB_TESTS === "1";

if (skipDbTests) {
  console.warn("[db tests] SKIPPED: SKIP_DB_TESTS=1 is set. Unset it to run the database tests.");
}

/** `describe` for tests that need a database: skipped, visibly, only under `SKIP_DB_TESTS=1`. */
export const describeDb: typeof describe = ((name: string, fn?: () => void) =>
  skipDbTests
    ? describe.skip(`${name} [SKIPPED: SKIP_DB_TESTS=1]`, fn)
    : describe(name, fn)) as typeof describe;

/** Quotes a Postgres identifier. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function serverUrl(): string {
  return (
    process.env.TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    DEFAULT_TEST_SERVER_URL
  );
}

/** The same server and credentials with a different database name. */
function withDatabase(url: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL error carries the input; drop it.
    throw new Error("TEST_DATABASE_URL / DATABASE_URL must be a postgres:// URL with a host.");
  }
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

async function withAdminClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface EmptyDatabase {
  /** Connection URL of the empty throwaway database. */
  readonly url: Secret<string>;
  /** Drops the database, even if other connections are still open. */
  drop(): Promise<void>;
}

/**
 * Creates an empty `docmyrepos_test_<random>` database with no migrations applied, for tests that
 * run the migration tooling itself. Always call `drop()`.
 */
export async function createEmptyDatabase(): Promise<EmptyDatabase> {
  const adminUrl = serverUrl();
  const name = `docmyrepos_test_${randomBytes(8).toString("hex")}`;
  const url = withDatabase(adminUrl, name);
  try {
    await withAdminClient(adminUrl, (c) => c.query(`CREATE DATABASE ${quoteIdent(name)}`));
  } catch (error) {
    throw new Error(
      `Cannot create the test database on the test server (${describeDbError(error)}). ${UNREACHABLE_HELP}`,
    );
  }
  let dropped: Promise<void> | undefined;
  return redactWhenLogged({
    url: new Secret(url),
    drop: () =>
      (dropped ??= withAdminClient(adminUrl, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
      ).then(() => undefined)),
  });
}

/**
 * Creates `docmyrepos_test_<random>` on the test server, applies every migration through the
 * same migrator the app uses, and returns a handle bound to it. Always call `drop()` (in
 * `afterAll`). Fails with an actionable message when the server cannot be reached.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = serverUrl();
  const name = `docmyrepos_test_${randomBytes(8).toString("hex")}`;
  const url = withDatabase(adminUrl, name);

  try {
    await withAdminClient(adminUrl, (c) => c.query(`CREATE DATABASE ${quoteIdent(name)}`));
  } catch (error) {
    throw new Error(
      `Cannot create the test database on the test server (${describeDbError(error)}). ${UNREACHABLE_HELP}`,
    );
  }

  const handle = createDb(url, { max: 4, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  let dropped: Promise<void> | undefined;
  const drop = () =>
    (dropped ??= (async () => {
      await handle.close().catch(() => undefined);
      await withAdminClient(adminUrl, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
      );
    })());

  try {
    await runMigrations(handle, MIGRATIONS_FOLDER);
  } catch (error) {
    await drop().catch(() => undefined);
    throw new Error(`Applying migrations to the test database failed (${describeDbError(error)}).`);
  }
  // The spread drops the redaction of `handle`; apply it again to the result.
  return redactWhenLogged({ ...handle, url: new Secret(url), drop });
}

/** SQLSTATE of a Postgres error, looking through Drizzle's wrapper (`cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
