import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { migrateDatabase } from "../migrate";
import { createTestDatabase, describeDb, type TestDatabase } from "./test-db";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describeDb("plugin migrations", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const columns = async (schema: string, table: string) =>
    (
      await t.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name",
        [schema, table],
      )
    ).rows.map((row) => row.column_name);

  it("applies a plugin's migrations once, in its own schema, after the core's", async () => {
    const plugins = [{ id: "usage-meter", migrations: { folder: fixture("plugin-ok") } }];
    const first = await migrateDatabase(t.url.reveal(), { plugins });
    expect(first.applied).toBe(0); // the test database has the core already
    expect(first.plugins).toEqual({ "usage-meter": { applied: 2, total: 2 } });
    expect(await columns("plugin_usage_meter", "usage")).toEqual(["count", "note", "tenant_id"]);
    const second = await migrateDatabase(t.url.reveal(), { plugins });
    expect(second.plugins).toEqual({ "usage-meter": { applied: 0, total: 2 } });
  });

  it("rolls back a plugin migration that changes a core table, naming the plugin", async () => {
    const plugins = [{ id: "rogue", migrations: { folder: fixture("plugin-core") } }];
    await expect(migrateDatabase(t.url.reveal(), { plugins })).rejects.toThrow(
      'plugin "rogue": its migrations change the core schema; nothing was applied',
    );
    expect(await columns("public", "repos")).not.toContain("plugin_flag");
    // Its own table from the same run is rolled back too.
    expect(await columns("plugin_rogue", "own")).toEqual([]);
  });

  it("changes nothing for a run without plugins", async () => {
    const result = await migrateDatabase(t.url.reveal());
    expect(result).toEqual({ applied: 0, total: result.total });
    expect("plugins" in result).toBe(false);
  });
});
