import { expect, it } from "vitest";

import { createDb } from "./client";
import { closeWithin, createTestDatabase, describeDb, pgErrorCode } from "./test-db";

describeDb("test database helper", () => {
  it("drops the database even when a client was never released", { timeout: 20_000 }, async () => {
    const t = await createTestDatabase();
    const other = createDb(t.url.reveal(), { max: 2 });
    // Both pools keep a checked-out client forever, as a hanging test would. The test's own
    // client gets an error listener; the helper's pool must cope without one.
    await t.pool.connect();
    const held = await other.pool.connect();
    held.on("error", () => undefined);

    const started = performance.now();
    expect(await closeWithin(other, 200)).toBe(false);
    await t.drop();
    expect(performance.now() - started).toBeLessThan(10_000);

    // The database is gone: connecting to it fails with invalid_catalog_name.
    const probe = createDb(t.url.reveal(), { max: 1 });
    try {
      const error = await probe.pool.query("select 1").catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe("3D000");
    } finally {
      await probe.close();
    }
  });

  it("reports a drained pool as closed", async () => {
    const t = await createTestDatabase();
    try {
      await t.pool.query("select 1");
      expect(await closeWithin(t, 5_000)).toBe(true);
    } finally {
      await t.drop();
    }
  });
});
