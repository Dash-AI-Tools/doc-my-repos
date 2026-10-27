import { afterAll, beforeAll, expect, it } from "vitest";

import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { siteBranding } from "../db/schema";
import { columnLogoStore, DEFAULT_BRANDING, getBranding, readBrandingSettings } from "./index";

describeDb("branding reads", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("reads defaults from an empty table", async () => {
    await t.db.delete(siteBranding);
    expect(await getBranding(t.db)).toEqual(DEFAULT_BRANDING);
    expect(await columnLogoStore(t.db).get()).toBeNull();
  });

  it("reads partial settings without the logo bytes, and a logo row as stored before", async () => {
    await t.db.delete(siteBranding);
    await t.db.insert(siteBranding).values({
      id: 1,
      orgName: "Acme",
      primaryColor: "#2b59ff",
      logo: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      logoType: "png",
      logoVersion: 3,
    });
    const settings = await getBranding(t.db);
    expect(settings).toMatchObject({
      orgName: "Acme",
      pageTitle: null,
      primaryColor: "#2b59ff",
      accentColor: null,
      logoVersion: 3,
      hasLogo: true,
    });
    expect("logo" in settings).toBe(false);
    // The row as earlier releases wrote it reads through the default logo store unchanged.
    expect(await columnLogoStore(t.db).get()).toEqual({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });
    expect((await readBrandingSettings(t.db)).logoVersion).toBe(3);
  });

  it("reads corrupt stored values as the default", async () => {
    await t.db.delete(siteBranding);
    await t.db.insert(siteBranding).values({
      id: 1,
      orgName: "a\u0001b\u202Ec",
      pageTitle: "t".repeat(200),
      primaryColor: "#fff;} body{display:none",
      accentColor: "red",
    });
    const settings = await getBranding(t.db);
    expect(settings.orgName).toBeNull();
    expect(settings.pageTitle).toBeNull();
    expect(settings.primaryColor).toBeNull();
    expect(settings.accentColor).toBeNull();
  });
});
