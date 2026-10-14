import { assertPostgresReachable } from "./db";
import { SKIP_DB } from "./stack";

/**
 * Runs before the (slow) production build, as the first part of the first web server's command in
 * `playwright.config.ts`, so a missing database fails in a second instead of after the build.
 * `global-setup.ts` checks again.
 */
async function main(): Promise<void> {
  if (SKIP_DB) return;
  await assertPostgresReachable();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Postgres preflight failed");
  process.exit(1);
});
