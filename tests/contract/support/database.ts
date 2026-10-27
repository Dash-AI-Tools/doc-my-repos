import { randomBytes } from "node:crypto";

import pg from "pg";

import { migrateDatabase } from "@docmyrepos/server/migrate";

/**
 * Throwaway Postgres databases for the contract suite, created on the test server
 * (`TEST_DATABASE_URL`, then `DATABASE_URL`, then the compose database) and migrated through the
 * public migration routine. Each test file drops what it creates.
 */
const SERVER_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://docmyrepos:docmyrepos@127.0.0.1:5432/docmyrepos";

export interface ContractDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: SERVER_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function createContractDatabase(): Promise<ContractDatabase> {
  const name = `docmyrepos_contract_${randomBytes(6).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = new URL(SERVER_URL);
  url.pathname = `/${name}`;
  await migrateDatabase(url.toString());
  return {
    url: url.toString(),
    drop: () =>
      admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => {}),
  };
}
