import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAdvisoryLock } from "./advisory-lock";
import { createDb } from "./client";
import { MIGRATION_LOCK_KEY, MigrationError, migrateDatabase, runMigrations } from "./migrate";
import {
  apiSpecs,
  askSettings,
  askUsage,
  codeOwners,
  docComments,
  documents,
  repos,
  settingsAudit,
  siteBranding,
  syncRuns,
  users,
  workspaceSecrets,
  workspaceSettings,
} from "./schema";
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

const tables: AnyPgTable[] = [
  repos,
  documents,
  codeOwners,
  syncRuns,
  users,
  siteBranding,
  docComments,
  apiSpecs,
  askSettings,
  askUsage,
  workspaceSettings,
  workspaceSecrets,
  settingsAudit,
];

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

  it("adds repos.star_position nullable with no default, so existing rows stay unstarred", async () => {
    const { rows } = await t.pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'repos' AND column_name = 'star_position'`,
    );
    expect(rows).toEqual([{ is_nullable: "YES", column_default: null }]);
  });

  it("has the doc_comments indexes, checks and foreign keys, and none to repos or documents", async () => {
    const { rows: idx } = await t.pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'doc_comments' AND indexname <> 'doc_comments_pkey' ORDER BY indexname",
    );
    expect(idx.map((r) => r.indexname)).toEqual([
      "doc_comments_created_idx",
      "doc_comments_doc_created_idx",
    ]);
    expect(idx[0]?.indexdef).toMatch(/\(created_at DESC NULLS LAST\)/);
    expect(idx[1]?.indexdef).toMatch(/\(github_repo_id, path, created_at\)/);
    const { rows: cons } = await t.pool.query<{
      conname: string;
      contype: string;
      ref: string | null;
    }>(
      `SELECT conname, contype, confrelid::regclass::text AS ref FROM pg_constraint
       WHERE conrelid = 'public.doc_comments'::regclass AND contype IN ('c', 'f') ORDER BY conname`,
    );
    expect(cons.filter((c) => c.contype === "c").map((c) => c.conname)).toEqual([
      "doc_comments_body_length",
      "doc_comments_reply_not_resolved",
    ]);
    expect(
      cons
        .filter((c) => c.contype === "f")
        .map((c) => c.ref)
        .sort(),
    ).toEqual(["doc_comments", "users", "users"]);
  });

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
      { table_name: "api_specs", column_name: "id", kind: "identity" },
      { table_name: "ask_usage", column_name: "id", kind: "identity" },
      { table_name: "code_owners", column_name: "id", kind: "identity" },
      { table_name: "doc_comments", column_name: "id", kind: "identity" },
      { table_name: "documents", column_name: "id", kind: "identity" },
      { table_name: "documents", column_name: "search_vector", kind: "generated" },
      { table_name: "repos", column_name: "id", kind: "identity" },
      { table_name: "settings_audit", column_name: "id", kind: "identity" },
      { table_name: "sync_runs", column_name: "id", kind: "identity" },
      { table_name: "users", column_name: "id", kind: "identity" },
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

describeDb("the doc_comments migration onto an existing database", () => {
  let empty: EmptyDatabase;
  let dir: string;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
    // The migrations before doc_comments, as a database from the previous release has them.
    dir = mkdtempSync(join(tmpdir(), "docmyrepos-prior-"));
    mkdirSync(join(dir, "meta"));
    const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const doc = journal.entries.findIndex((e) => e.tag.includes("_pale_jetstream"));
    const prior = journal.entries.slice(0, doc);
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const e of prior) copyFileSync(`${drizzleDir}/${e.tag}.sql`, join(dir, `${e.tag}.sql`));
  }, 60_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await empty?.drop();
  }, 60_000);

  it("adds the table and leaves existing rows untouched", async () => {
    const handle = createDb(empty.url.reveal(), { max: 2 });
    try {
      await runMigrations(handle, dir);
      await handle.pool.query(
        "INSERT INTO users (email, password_hash) VALUES ('old@example.com', 'x')",
      );
      const before = await handle.pool.query("SELECT to_regclass('public.doc_comments') AS t");
      expect(before.rows[0]?.t).toBeNull();

      const result = await runMigrations(handle, drizzleDir);
      expect(result.total).toBe(journalLength);
      const after = await handle.pool.query("SELECT to_regclass('public.doc_comments') AS t");
      expect(after.rows[0]?.t).toBe("doc_comments");
      const users = await handle.pool.query("SELECT email FROM users");
      expect(users.rows).toEqual([{ email: "old@example.com" }]);
    } finally {
      await handle.close();
    }
  }, 60_000);
});

describeDb("the ask migration onto an existing database", () => {
  let empty: EmptyDatabase;
  let dir: string;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
    // The migrations before the Ask tables, as a database from the previous release has them.
    dir = mkdtempSync(join(tmpdir(), "docmyrepos-prior-ask-"));
    mkdirSync(join(dir, "meta"));
    const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const ask = journal.entries.findIndex((e) => e.tag.includes("_sweet_expediter"));
    const prior = journal.entries.slice(0, ask);
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const e of prior) copyFileSync(`${drizzleDir}/${e.tag}.sql`, join(dir, `${e.tag}.sql`));
  }, 60_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await empty?.drop();
  }, 60_000);

  it("adds both tables and leaves existing rows untouched", async () => {
    const handle = createDb(empty.url.reveal(), { max: 2 });
    try {
      await runMigrations(handle, dir);
      await handle.pool.query(
        "INSERT INTO users (email, password_hash) VALUES ('old@example.com', 'x')",
      );
      const before = await handle.pool.query("SELECT to_regclass('public.ask_usage') AS t");
      expect(before.rows[0]?.t).toBeNull();

      await runMigrations(handle, drizzleDir);
      const after = await handle.pool.query(
        "SELECT to_regclass('public.ask_usage') AS u, to_regclass('public.ask_settings') AS s",
      );
      expect(after.rows[0]).toEqual({ u: "ask_usage", s: "ask_settings" });
      const users = await handle.pool.query("SELECT email FROM users");
      expect(users.rows).toEqual([{ email: "old@example.com" }]);
      // No settings row exists until an admin saves: Ask is off by default.
      const settings = await handle.pool.query("SELECT count(*)::int AS n FROM ask_settings");
      expect(settings.rows[0]?.n).toBe(0);
    } finally {
      await handle.close();
    }
  }, 60_000);
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

describeDb("parallel db:migrate runs on one empty database", () => {
  let empty: EmptyDatabase;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
  }, 60_000);
  afterAll(async () => {
    await empty?.drop();
  }, 60_000);

  it("take turns: every run succeeds and exactly one applies the migrations", async () => {
    const env = { DATABASE_URL: empty.url.reveal() };
    const results = await Promise.all([cli(env), cli(env), cli(env)]);
    // The migration advisory lock (task 13.2) serializes the runs: the first applies everything,
    // the others wait, then find nothing left to apply. None fails on the bookkeeping table.
    for (const r of results) {
      expect(r).toMatchObject({ code: 0, stderr: "" });
      expect(r.stdout).not.toContain(empty.url.reveal());
    }
    const applied = results.filter((r) => r.stdout.startsWith("Applied "));
    expect(applied).toHaveLength(1);
    expect(results.filter((r) => r.stdout.includes("up to date"))).toHaveLength(2);

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
        "api_specs",
        "ask_settings",
        "ask_usage",
        "code_owners",
        "doc_comments",
        "documents",
        "repos",
        "settings_audit",
        "site_branding",
        "sync_runs",
        "users",
        "workspace_secrets",
        "workspace_settings",
      ]);
    } finally {
      await client.end();
    }
  }, 120_000);
});

describeDb("the migration lock", () => {
  let empty: EmptyDatabase;
  beforeAll(async () => {
    empty = await createEmptyDatabase();
  }, 60_000);
  afterAll(async () => {
    await empty?.drop();
  }, 60_000);

  it("makes a run wait for the holder, and gives up with a clear message when it does not finish", async () => {
    const env = { DATABASE_URL: empty.url.reveal() };
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holderDb = createDb(empty.url.reveal(), { max: 1 });
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (entered = resolve));
    const holder = withAdvisoryLock(holderDb.pool, MIGRATION_LOCK_KEY, async () => {
      entered();
      await held;
    });
    await holding;

    // Another run holds the lock: a short wait ends in a MigrationError that names no connection.
    const timedOut = await caught(migrateDatabase(env, drizzleDir, { lockWaitMs: 300 }));
    expect(timedOut).toBeInstanceOf(MigrationError);
    expect(timedOut.message).toBe(
      "another migration run holds the lock (timeout); gave up after 0 s",
    );
    expect(timedOut.message).not.toContain(empty.url.reveal());

    // Released while a run waits: that run proceeds and applies the migrations.
    const waiting = migrateDatabase(env, drizzleDir, { lockWaitMs: 10_000 });
    setTimeout(release, 400);
    await expect(waiting).resolves.toEqual({ applied: journalLength, total: journalLength });
    expect((await holder).acquired).toBe(true);
    await holderDb.close();
  }, 60_000);
});

describe("an unreachable database", () => {
  it("reports it as not reachable after one attempt when waiting is off", async () => {
    const error = await caught(migrateDatabase({ DATABASE_URL: URL_NEVER_USED }, drizzleDir));
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.message).toBe(
      "DATABASE_URL: database not reachable after 1 attempt, database error (ECONNREFUSED)",
    );
    expect(error.message).not.toMatch(/leak|127\.0\.0\.1/);
  });

  it("retries for the wait time, then fails with the attempt count", async () => {
    const retries: number[] = [];
    const started = Date.now();
    const error = await caught(
      migrateDatabase({ DATABASE_URL: URL_NEVER_USED }, drizzleDir, {
        waitForDatabaseMs: 600,
        waitIntervalMs: 100,
        onWait: ({ attempt }) => retries.push(attempt),
      }),
    );
    expect(error.message).toMatch(
      /^DATABASE_URL: database not reachable after [2-9] attempts, database error \(ECONNREFUSED\)$/,
    );
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(error.message).not.toMatch(/leak/);
  });
});
