import { afterAll, beforeAll, expect, it } from "vitest";

import { siteBranding } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { handleLogoRequest } from "./serve";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function get(
  path: string,
  headers: Record<string, string> = [] as unknown as Record<string, string>,
): Request {
  return new Request(`http://localhost${path}`, { headers });
}

describeDb("public logo route", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("404s when no logo is stored", async () => {
    await t.db.delete(siteBranding);
    const response = await handleLogoRequest(get("/api/branding/logo"), () => t.db);
    expect(response.status).toBe(404);
  });

  it("serves the verified type with sandbox headers, ETag/304, and immutable versioned cache", async () => {
    await t.db.delete(siteBranding);
    await t.db
      .insert(siteBranding)
      .values({ id: 1, logo: Buffer.from(PNG), logoType: "png", logoVersion: 4 });
    const response = await handleLogoRequest(get("/api/branding/logo"), () => t.db);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toMatch(/^".+"$/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

    const notModified = await handleLogoRequest(
      get("/api/branding/logo", { "if-none-match": etag }),
      () => t.db,
    );
    expect(notModified.status).toBe(304);

    const versioned = await handleLogoRequest(get("/api/branding/logo?v=4"), () => t.db);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const stale = await handleLogoRequest(get("/api/branding/logo?v=3"), () => t.db);
    expect(stale.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("sandsboxes SVG with the style variant", async () => {
    await t.db.delete(siteBranding);
    await t.db
      .insert(siteBranding)
      .values({ id: 1, logo: Buffer.from(SVG), logoType: "svg", logoVersion: 1 });
    const response = await handleLogoRequest(get("/api/branding/logo"), () => t.db);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });
});
