// Applies the SQL migrations in ./drizzle to the database named by DATABASE_URL.
// Needs only DATABASE_URL: no GitHub App settings. Prints counts and the variable name, never
// a connection string. `pnpm db:migrate` runs it with tsx; `pnpm build:migrate` bundles it to
// dist/db-migrate.mjs, which runs with plain `node` and only needs drizzle-orm, pg and zod.
import { resolve } from "node:path";

import { MigrationError, migrateDatabase } from "../src/server/db/migrate";

async function main(): Promise<void> {
  const folder = resolve(process.env.MIGRATIONS_DIR?.trim() || "drizzle");
  const { applied, total } = await migrateDatabase(process.env, folder);
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
