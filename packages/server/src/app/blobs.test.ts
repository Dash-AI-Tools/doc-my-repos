import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { DEFAULT_TENANT } from "@docmyrepos/core";

import { readBrandingSettings } from "../branding";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createApp } from "./create-app";
import { UnsupportedBlobError } from "./defaults";

const CONFIG = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/unused",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The default blob store keeps `branding/logo` in the tenant's `site_branding` row. */
describeDb("the default blob store", () => {
  let t: TestDatabase;
  const forTenant = vi.fn(async () => t);
  const app = createApp({ config: CONFIG, adapters: { database: { forTenant } } });

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("stores the logo in the database the app's database adapter gives", async () => {
    const { blobs } = app.adapters;
    await blobs.put(DEFAULT_TENANT, "branding/logo", { bytes: PNG, contentType: "image/png" });
    expect(forTenant).toHaveBeenCalledWith(DEFAULT_TENANT);
    expect(await blobs.get(DEFAULT_TENANT, "branding/logo")).toEqual({
      bytes: PNG,
      contentType: "image/png",
    });
    // The bytes alone do not bump the version: the logo handlers record the change.
    expect((await readBrandingSettings(t.db)).logoVersion).toBe(0);
    await blobs.delete(DEFAULT_TENANT, "branding/logo");
    expect(await blobs.get(DEFAULT_TENANT, "branding/logo")).toBeNull();
  });

  it("rejects any other name, and a logo that is not an image type", async () => {
    const { blobs } = app.adapters;
    await expect(blobs.get(DEFAULT_TENANT, "exports/report.pdf")).rejects.toThrow(
      UnsupportedBlobError,
    );
    await expect(
      blobs.put(DEFAULT_TENANT, "branding/logo", { bytes: PNG, contentType: "text/html" }),
    ).rejects.toThrow();
  });
});
