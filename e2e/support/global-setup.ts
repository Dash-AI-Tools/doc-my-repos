import { resolve } from "node:path";

import { createDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { assertPostgresReachable, createDatabase } from "./db";
import { seedDatabase } from "./seed";
import {
  SKIP_DB,
  SKIP_DB_REASON,
  databaseName,
  databaseUrl,
  runId,
  workDir,
  type DatabaseKind,
} from "./stack";
import teardown from "./global-teardown";

/**
 * Playwright global setup (task 9.2). Runs AFTER the web servers in `playwright.config.ts` have
 * started (Playwright's order), which is fine: the servers connect on their first data request.
 *
 * 1. Requires a reachable Postgres. If it is not, it fails loudly with the command that starts it,
 *    unless `E2E_SKIP_DB=1`, in which case it only prints a warning and the database-backed specs
 *    skip themselves.
 * 2. Creates `docmyrepos_e2e_<id>_seeded` and `_empty` (random id per run), applies every
 *    migration to both, and seeds the first with `seed-data.ts`.
 * 3. If any step fails, it drops what it created before rethrowing (Playwright does not run the
 *    teardown of a setup that threw). `global-teardown.ts` drops them after a normal run.
 */

const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle");

async function prepare(kind: DatabaseKind): Promise<void> {
  await createDatabase(databaseName(kind));
  // Recorded right after creation so the teardown drops exactly what exists.
  process.env.E2E_DATABASES_CREATED = [process.env.E2E_DATABASES_CREATED, databaseName(kind)]
    .filter(Boolean)
    .join(",");
  const handle = createDb(databaseUrl(kind), { max: 2, connectTimeoutMs: 5_000 });
  try {
    await runMigrations(handle, MIGRATIONS_FOLDER);
    if (kind === "seeded") await seedDatabase(handle.db);
  } finally {
    await handle.close();
  }
}

export default async function globalSetup(): Promise<void> {
  workDir();
  runId();
  if (SKIP_DB) {
    console.warn(`[e2e] ${SKIP_DB_REASON}`);
    return;
  }
  try {
    await assertPostgresReachable();
    await prepare("seeded");
    await prepare("empty");
  } catch (error) {
    await teardown();
    throw error;
  }
}
