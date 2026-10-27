// Applies the SQL migrations in ./drizzle to the database named by DATABASE_URL.
// Needs only DATABASE_URL: no GitHub App settings. Prints counts and the variable name, never
// a connection string. `pnpm db:migrate` runs it with tsx; `pnpm build:migrate` bundles it, with
// its dependencies, to dist/db-migrate.mjs, which runs with plain `node` and needs no node_modules
// (the Docker image does this on every start).
//
// Environment: MIGRATIONS_DIR (default ./drizzle), DB_WAIT_SECONDS (default 0: do not wait; the
// image entrypoint sets 60): retry connection problems that can pass, such as a database that is
// still starting, for up to that many seconds. Runs are serialized by an advisory lock, so several
// containers may start at once.
import { resolve } from "node:path";

import { MigrationError, migrateDatabase } from "../packages/server/src/db/migrate";
import { parseWaitSeconds } from "../packages/server/src/db/wait";

async function main(): Promise<void> {
  const folder = resolve(process.env.MIGRATIONS_DIR?.trim() || "drizzle");
  const wait = parseWaitSeconds(process.env.DB_WAIT_SECONDS);
  if (!wait.ok) throw new MigrationError(wait.problem);

  const { applied, total } = await migrateDatabase(process.env, folder, {
    waitForDatabaseMs: wait.seconds * 1000,
    // The first retry and then every fifth, so a 60 s wait prints a handful of lines.
    onWait: ({ attempt, elapsedMs }) => {
      if (attempt === 1 || attempt % 5 === 0) {
        console.error(
          `Waiting for the database to accept connections (${Math.round(elapsedMs / 1000)} s of ${wait.seconds} s)...`,
        );
      }
    },
  });
  console.log(
    applied === 0
      ? `Database is up to date (${total} migrations already applied, none applied now).`
      : `Applied ${applied} migration${applied === 1 ? "" : "s"} (${total} total).`,
  );
}

main().catch((error: unknown) => {
  // Only MigrationError text is printed: it is built to hold no connection detail.
  console.error(error instanceof MigrationError ? error.message : "Migration failed.");
  process.exitCode = 1;
});
