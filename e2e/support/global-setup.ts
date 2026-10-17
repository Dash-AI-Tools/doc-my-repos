import { resolve } from "node:path";

import { createDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { assertPostgresReachable, createDatabase } from "./db";
import { seedAskData } from "./ask-seed";
import { seedSettings } from "./settings-seed";
import { seedAgentData } from "./agent-seed";
import { seedCommentData } from "./comment-seed";
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
 * 2. Creates `docmyrepos_e2e_<id>_seeded`, `_empty`, `_starred`, ... (random id per run), applies every
 *    migration, seeds most with `seed-data.ts` and saves the workspace settings some start with
 *    (`settings-seed.ts`). `_settings` starts empty and unconfigured.
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
    if (kind !== "empty" && kind !== "settings") await seedDatabase(handle.db);
    await seedSettings(handle.db, kind);
    if (
      kind === "comments" ||
      kind === "commentsoff" ||
      kind === "ask" ||
      kind === "agent" ||
      kind === "agentoff"
    ) {
      await seedCommentData(handle.db);
    }
    if (kind === "agent" || kind === "agentoff") await seedAgentData(handle.db);
    if (kind === "ask") await seedAskData(handle.db);
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
    await prepare("starred");
    await prepare("comments");
    await prepare("commentsoff");
    await prepare("ask");
    await prepare("settings");
    await prepare("agent");
    await prepare("agentoff");
  } catch (error) {
    await teardown();
    throw error;
  }
}
