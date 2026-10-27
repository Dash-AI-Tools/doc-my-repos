import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";

import { describeDbError } from "./client";

/**
 * A plugin's SQL migrations (plugin-api): a Drizzle migrations folder (`meta/_journal.json` and
 * the `.sql` files it lists), applied after the core's into the plugin's own schema.
 */
export interface PluginMigrations {
  readonly id: string;
  readonly migrations?: { readonly folder: string };
}

export interface PluginMigrateResult {
  readonly applied: number;
  readonly total: number;
}

/** A plugin's migrations could not be applied. Names the plugin and the file, never SQL or URLs. */
export class PluginMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginMigrationError";
  }
}

/** The plugin's schema: `plugin_<id>`, with the id's hyphens as underscores. */
export function pluginSchema(id: string): string {
  return `plugin_${id.replace(/-/g, "_")}`;
}

/**
 * The shape of the core's `public` schema: tables, columns, constraints, indexes and triggers. A
 * plugin migration that changes it is rolled back.
 */
const FINGERPRINT = `
  SELECT coalesce(string_agg(item, E'\\n' ORDER BY item), '') AS fingerprint FROM (
    SELECT 't:' || table_name || ':' || table_type AS item
      FROM information_schema.tables WHERE table_schema = 'public'
    UNION ALL
    SELECT 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
        || ':' || coalesce(column_default, '')
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'k:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'i:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT 'g:' || c.relname || ':' || t.tgname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
  ) items`;

async function fingerprint(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ fingerprint: string }>(FINGERPRINT);
  return rows[0]?.fingerprint ?? "";
}

function readFolder(id: string, folder: string) {
  if (!existsSync(join(folder, "meta", "_journal.json"))) {
    throw new PluginMigrationError(`plugin "${id}": its migrations folder has no journal`);
  }
  try {
    const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const files = readMigrationFiles({ migrationsFolder: folder });
    return files.map((file, i) => ({ ...file, tag: journal.entries[i]?.tag ?? String(i) }));
  } catch {
    throw new PluginMigrationError(
      `plugin "${id}": its migrations journal is invalid or lists a file that cannot be read`,
    );
  }
}

/**
 * Applies one plugin's pending migrations in ONE transaction, in schema `plugin_<id>` (created if
 * needed, and first on the `search_path`), recording them in that schema's own journal table.
 * The core's `public` schema is fingerprinted before and after: any change rolls everything back
 * and fails naming the plugin. Idempotent: a second run applies nothing.
 */
export async function migratePlugin(
  pool: pg.Pool,
  plugin: PluginMigrations,
): Promise<PluginMigrateResult> {
  if (plugin.migrations === undefined) return { applied: 0, total: 0 };
  const files = readFolder(plugin.id, plugin.migrations.folder);
  const schema = pluginSchema(plugin.id);
  const client = await pool.connect();
  let current: string | undefined;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".__migrations (hash text PRIMARY KEY, created_at bigint NOT NULL)`,
    );
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const before = await fingerprint(client);
    const done = new Set(
      (await client.query<{ hash: string }>(`SELECT hash FROM "${schema}".__migrations`)).rows.map(
        (row) => row.hash,
      ),
    );
    let applied = 0;
    for (const file of files) {
      if (done.has(file.hash)) continue;
      current = file.tag;
      for (const statement of file.sql) {
        if (statement.trim() !== "") await client.query(statement);
      }
      await client.query(
        `INSERT INTO "${schema}".__migrations (hash, created_at) VALUES ($1, $2)`,
        [file.hash, file.folderMillis],
      );
      applied += 1;
    }
    current = undefined;
    if ((await fingerprint(client)) !== before) {
      throw new PluginMigrationError(
        `plugin "${plugin.id}": its migrations change the core schema; nothing was applied`,
      );
    }
    await client.query("COMMIT");
    return { applied, total: files.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof PluginMigrationError) throw error;
    throw new PluginMigrationError(
      `plugin "${plugin.id}": migration ${current === undefined ? "" : `${current}.sql `}failed, ${describeDbError(error)}`,
    );
  } finally {
    client.release();
  }
}
