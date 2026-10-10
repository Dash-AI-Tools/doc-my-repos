import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MigrationError, migrateDatabase, runMigrations } from "./migrate";
import { codeOwners, documents, repos, syncRuns } from "./schema";
import {
  createEmptyDatabase,
  createTestDatabase,
  describeDb,
  type EmptyDatabase,
  type TestDatabase,
} from "./test-db";

const drizzleDir = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const journalLength = (
  JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as { entries: unknown[] }
).entries.length;

const tables: AnyPgTable[] = [repos, documents, codeOwners, syncRuns];

describeDb("migrations on a real database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("applied every journal entry to the empty database", async () => {
    const { rows } = await t.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    expect(rows[0]?.n).toBe(journalLength);
    expect(journalLength).toBeGreaterThanOrEqual(3);
  });

  it("applies nothing on a second run", async () => {
    const result = await runMigrations(t, drizzleDir);
    expect(result).toEqual({ applied: 0, total: journalLength });
  });

  it("created the immutable helper function used by the generated column", async () => {
    const { rows } = await t.pool.query<{ provolatile: string }>(
      "SELECT provolatile FROM pg_proc WHERE proname = 'docmyrepos_immutable_array_to_string'",
    );
    expect(rows).toEqual([{ provolatile: "i" }]);
  });

  it("has exactly the tables defined in schema.ts", async () => {
    const { rows } = await t.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(tables.map((x) => getTableConfig(x).name).sort());
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    it(`${config.name}: columns, types and nullability match schema.ts`, async () => {
      const { rows } = await t.pool.query<{
        name: string;
        type: string;
        notnull: boolean;
      }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
         FROM pg_attribute a
         WHERE a.attrelid = ('public.' || quote_ident($1))::regclass AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attname`,
        [config.name],
      );
      const actual = rows.map((r) => ({ name: r.name, type: r.type, notNull: r.notnull }));
      const expected = config.columns
        .map((c) => ({ name: c.name, type: c.getSQLType(), notNull: c.notNull }))
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
      expect(actual).toEqual(expected);
    });
  }

  it("has the sync_runs started_at index", async () => {
    const { rows } = await t.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'sync_runs_started_at_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/ON public\.sync_runs USING btree \(started_at\)$/);
  });

  it("has a document_reserved enum of exactly index and log", async () => {
    const { rows } = await t.pool.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
       WHERE ty.typname = 'document_reserved' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["index", "log"]);
  });

  it("marks id columns as identity and search_vector as generated", async () => {
    const { rows } = await t.pool.query<{ table_name: string; column_name: string; kind: string }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              CASE WHEN a.attidentity = 'a' THEN 'identity' WHEN a.attgenerated = 's' THEN 'generated' END AS kind
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r' AND a.attnum > 0 AND (a.attidentity = 'a' OR a.attgenerated = 's')
       ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { table_name: "code_owners", column_name: "id", kind: "identity" },
      { table_name: "documents", column_name: "id", kind: "identity" },
      { table_name: "documents", column_name: "search_vector", kind: "generated" },
      { table_name: "repos", column_name: "id", kind: "identity" },
      { table_name: "sync_runs", column_name: "id", kind: "identity" },
    ]);
  });
});

async function caught(promise: PromiseLike<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

/** A scratch migrations folder: `files` maps a journal tag to the SQL of that migration. */
function scratchMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "docmyrepos-migrations-"));
  mkdirSync(join(dir, "meta"));
  const entries = Object.keys(files).map((tag, idx) => ({
    idx,
    version: "7",
    when: 1_800_000_000_000 + idx * 1000,
    tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  for (const [tag, text] of Object.entries(files)) writeFileSync(join(dir, `${tag}.sql`), text);
  return dir;
}

// Port 1 on loopback refuses at once; the folder checks must fail before any connection anyway.
const URL_NEVER_USED = "postgres://leakuser:leakpass@127.0.0.1:1/leakdb";

describe("migrations folder checks", () => {
  it("names MIGRATIONS_DIR when the folder is missing, before connecting", async () => {
    const error = await caught(migrateDatabase({ DATABASE_URL: URL_NEVER_USED }, "/nonexistent"));
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.message).toMatch(/^MIGRATIONS_DIR: migrations folder ".*nonexistent" not found/);
    expect(error.message).not.toMatch(/ECONNREFUSED|unknown error|leak/);
  });

  it("names MIGRATIONS_DIR when meta/_journal.json is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docmyrepos-empty-"));
    try {
      const error = await caught(migrateDatabase({ DATABASE_URL: URL_NEVER_USED }, dir));
      expect(error.message).toMatch(/^MIGRATIONS_DIR: ".*_journal\.json" not found/);
      expect(error.message).not.toMatch(/ECONNREFUSED|leak/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("names MIGRATIONS_DIR when the journal lists a file that does not exist", async () => {
    const dir = scratchMigrations({ "0000_ok": "SELECT 1;" });
    try {
      rmSync(join(dir, "0000_ok.sql"));
      const error = await caught(migrateDatabase({ DATABASE_URL: URL_NEVER_USED }, dir));
      expect(error.message).toMatch(/^MIGRATIONS_DIR: the journal in ".*" is invalid or lists/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describeDb("a failing migration", () => {
  let empty: EmptyDatabase;
  let dir: string;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
    dir = scratchMigrations({
      "0000_first": "CREATE TABLE scratch_first (id integer);",
      "0001_broken":
        "CREATE TABLE scratch_second (id integer);--> statement-breakpoint\nSELECT * FROM table_that_is_missing;",
    });
  }, 60_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await empty?.drop();
  }, 60_000);

  it("fails naming the file and SQLSTATE only, and applies and records nothing", async () => {
    const error = await caught(migrateDatabase({ DATABASE_URL: empty.url.reveal() }, dir));
    expect(error).toBeInstanceOf(MigrationError);
    // 42P01 = undefined_table. No statement text, no table name, no URL.
    expect(error.message).toBe("migration 0001_broken.sql failed, database error (42P01)");

    const t = new (await import("pg")).Client({ connectionString: empty.url.reveal() });
    await t.connect();
    try {
      // drizzle-orm's migrator runs every pending migration in ONE transaction, so 0000_first,
      // which succeeded in the same run, is rolled back with the failing 0001_broken: no table
      // from either file exists and nothing is recorded as applied.
      const tables = await t.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'scratch_%'",
      );
      expect(tables.rows).toEqual([]);
      const recorded = await t.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
      expect(recorded.rows[0]?.n).toBe(0);
    } finally {
      await t.end();
    }
  });
});

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real `scripts/db-migrate.ts` with only the given environment. */
async function cli(env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      join(repoRoot, "node_modules/.bin/tsx"),
      [join(repoRoot, "scripts/db-migrate.ts")],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
        timeout: 60_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("scripts/db-migrate.ts exit codes", () => {
  it("exits 1 for a malformed DATABASE_URL, without echoing it", async () => {
    const result = await cli({ DATABASE_URL: "http://leakuser:leakpass@127.0.0.1/leakdb" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^DATABASE_URL: /);
    expect(result.stdout + result.stderr).not.toMatch(/leakuser|leakpass|leakdb/);
  }, 60_000);

  it("exits 1 when DATABASE_URL is not set", async () => {
    const result = await cli({});
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("DATABASE_URL: is not set");
  }, 60_000);

  it("exits 1 naming MIGRATIONS_DIR when the folder is missing", async () => {
    const result = await cli({ DATABASE_URL: URL_NEVER_USED, MIGRATIONS_DIR: "/nonexistent" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^MIGRATIONS_DIR: migrations folder/);
  }, 60_000);
});

describeDb("scripts/db-migrate.ts against a real database", () => {
  let empty: EmptyDatabase;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
  }, 60_000);
  afterAll(async () => {
    await empty?.drop();
  }, 60_000);

  it("migrates an empty database (exit 0) and is idempotent on the second run", async () => {
    const env = { DATABASE_URL: empty.url.reveal() };
    const first = await cli(env);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout.trim()).toBe(
      `Applied ${journalLength} migrations (${journalLength} total).`,
    );
    const second = await cli(env);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`up to date (${journalLength} migrations already applied`);
  }, 120_000);
});

describeDb("two db:migrate runs in parallel on one empty database", () => {
  let empty: EmptyDatabase;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
  }, 60_000);
  afterAll(async () => {
    await empty?.drop();
  }, 60_000);

  it("leaves the database consistent", async () => {
    const env = { DATABASE_URL: empty.url.reveal() };
    const results = await Promise.all([cli(env), cli(env)]);
    // Known gap, handled by tasks 3.4 and 13.2 (migration serialization): there is no advisory
    // lock yet, so the loser of the race can fail with an opaque unique violation (23505) from
    // the migrations bookkeeping and exit non-zero. We only require that the winner succeeds, that
    // a loser fails cleanly without the URL, and that the database ends fully migrated.
    expect(results.some((r) => r.code === 0)).toBe(true);
    for (const r of results) {
      expect(r.code === 0 || r.code === 1).toBe(true);
      expect(r.stdout + r.stderr).not.toContain(empty.url.reveal());
    }

    const { Client } = await import("pg");
    const client = new Client({ connectionString: empty.url.reveal() });
    await client.connect();
    try {
      const count = await client.query(
        "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
      );
      expect(count.rows[0]?.n).toBe(journalLength);
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        "code_owners",
        "documents",
        "repos",
        "sync_runs",
      ]);
    } finally {
      await client.end();
    }
  }, 120_000);
});
