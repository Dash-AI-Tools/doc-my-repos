import { Client } from "pg";

import { adminDatabaseUrl, START_DB_COMMAND } from "./stack";

/** Quotes a Postgres identifier. */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `host:port` of the admin URL, for messages: never the user, password or database. */
function describeServer(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}`;
  } catch {
    return "(invalid DATABASE_URL_E2E)";
  }
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Throws, naming the command that starts the database, when the Postgres server is not
 * reachable. The message holds no credentials.
 */
export async function assertPostgresReachable(url: string = adminDatabaseUrl()): Promise<void> {
  try {
    await withClient(url, (c) => c.query("select 1"));
  } catch {
    throw new Error(
      `The e2e tests need a reachable Postgres server (${describeServer(url)}).\n` +
        `Start one with:\n\n  ${START_DB_COMMAND}\n\n` +
        "or point DATABASE_URL_E2E at another server, or set E2E_SKIP_DB=1 to skip the specs that need a database.",
    );
  }
}

export async function createDatabase(
  name: string,
  url: string = adminDatabaseUrl(),
): Promise<void> {
  await withClient(url, (c) => c.query(`CREATE DATABASE ${quote(name)}`));
}

/** Drops the database even when connections (a running app server) are still open. */
export async function dropDatabase(name: string, url: string = adminDatabaseUrl()): Promise<void> {
  await withClient(url, (c) => c.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`));
}
