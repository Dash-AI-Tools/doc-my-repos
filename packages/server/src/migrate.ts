import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DATABASE_URL_VAR } from "./config/env";
import {
  migrateDatabase as migrateWithLock,
  type MigrateOptions,
  type MigrateResult,
} from "./db/migrate";

/**
 * `@docmyrepos/server/migrate`: the migration routine, on its own entrypoint because it reads the
 * migration files from disk and must never be bundled into the Next.js server.
 */

/**
 * The core's SQL migrations: copied next to this file in the published package (`dist/drizzle`),
 * the repository's `drizzle/` folder in the workspace.
 */
const PACKAGED_MIGRATIONS = fileURLToPath(new URL("./drizzle", import.meta.url));
export const CORE_MIGRATIONS_FOLDER = existsSync(PACKAGED_MIGRATIONS)
  ? PACKAGED_MIGRATIONS
  : fileURLToPath(new URL("../../../drizzle", import.meta.url));

export type { MigrateResult };
export type { PluginMigrateResult, PluginMigrations } from "./db/plugin-migrations";

export interface MigrateDatabaseOptions extends MigrateOptions {
  /** Default: the core's migrations shipped with this package. */
  readonly migrationsFolder?: string;
}

/**
 * Applies the core migrations to one Postgres database, under the same lock, waits and messages as
 * the open-source migration command, then each plugin's (`plugins`), in schema `plugin_<id>`, one
 * transaction per plugin, rolled back if it changes the core's tables. Idempotent: a second call
 * applies nothing. A host app calls it for each tenant database. Errors name the problem and the
 * plugin, never the URL or the SQL.
 */
export function migrateDatabase(
  url: string,
  options: MigrateDatabaseOptions = {},
): Promise<MigrateResult> {
  const { migrationsFolder = CORE_MIGRATIONS_FOLDER, ...rest } = options;
  return migrateWithLock({ [DATABASE_URL_VAR]: url }, migrationsFolder, rest);
}
