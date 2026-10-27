import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { siteBranding, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { hashPassword } from "../auth/password";
import { newSessionPayload, SESSION_COOKIE, signSession } from "../auth/session";
import { columnLogoStore, logoTypeOf, readBrandingSettings } from "../branding";
import {
  handleGetBranding,
  handleRemoveLogo,
  handleResetBranding,
  handleUpdateBranding,
  handleUploadLogo,
} from "./service";

const SECRET = "branding-service-test-secret-0123456789";

const jar = vi.hoisted(() => ({ cookie: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined,
  }),
}));

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describeDb("admin branding routes", () => {
  let t: TestDatabase;
  /** The stored logo's type and the row's version, or null when there is none. */
  const logoOf = async () => {
    const blob = await columnLogoStore(t.db).get();
    if (blob === null) return null;
    return {
      type: logoTypeOf(blob.contentType),
      version: (await readBrandingSettings(t.db)).logoVersion,
    };
  };
  let adminId = 0;
  let viewerId = 0;

  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    t = await createTestDatabase();
    const rows = await t.db
      .insert(users)
      .values([
        {
          email: "branding-admin@example.com",
          passwordHash: await hashPassword("admin-pass-1234"),
          role: "admin",
        },
        {
          email: "branding-viewer@example.com",
          passwordHash: await hashPassword("viewer-pass-1234"),
          role: "user",
        },
      ])
      .returning({ id: users.id });
    adminId = rows[0]?.id ?? 0;
    viewerId = rows[1]?.id ?? 0;
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await t?.drop();
  }, 60_000);

  function signInAs(role: "admin" | "user") {
    const id = role === "admin" ? adminId : viewerId;
    jar.cookie = signSession(SECRET, newSessionPayload(id, role, 0));
  }

  it("401s without a session and 403s for viewers", async () => {
    jar.cookie = "";
    expect((await handleGetBranding(t.db)).status).toBe(401);
    expect(
      (await handleUpdateBranding(jsonRequest("/api/admin/branding", "PUT", {}), t.db)).status,
    ).toBe(401);
    expect((await handleResetBranding(t.db)).status).toBe(401);
    signInAs("user");
    expect((await handleGetBranding(t.db)).status).toBe(403);
    expect(
      (await handleUpdateBranding(jsonRequest("/api/admin/branding", "PUT", {}), t.db)).status,
    ).toBe(403);
    expect((await handleResetBranding(t.db)).status).toBe(403);
  });

  it("rejects invalid values with a 400 naming the field and writes nothing", async () => {
    signInAs("admin");
    await t.db.delete(siteBranding);
    const bad = await handleUpdateBranding(
      jsonRequest("/api/admin/branding", "PUT", {
        orgName: "Acme",
        primaryColor: "not-a-color",
      }),
      t.db,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "primaryColor" });
    const current = (await (await handleGetBranding(t.db)).json()) as {
      branding: { orgName: string | null };
    };
    expect(current.branding.orgName).toBeNull();
  });

  it("applies a partial update, clears a field, and resets", async () => {
    signInAs("admin");
    await t.db.delete(siteBranding);
    const updated = await handleUpdateBranding(
      jsonRequest("/api/admin/branding", "PUT", {
        orgName: "Acme",
        primaryColor: "#2B59FF",
        coloredHeader: true,
      }),
      t.db,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      branding: {
        orgName: "Acme",
        primaryColor: "#2b59ff",
        coloredHeader: true,
        pageTitle: null,
      },
    });

    const cleared = await handleUpdateBranding(
      jsonRequest("/api/admin/branding", "PUT", { orgName: "" }),
      t.db,
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ branding: { orgName: null } });

    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const up = await handleUploadLogo(logoRequest(PNG, String(PNG.length)), t.db);
    expect(up.status).toBe(200);
    expect(await logoOf()).toMatchObject({ type: "png" });

    const reset = await handleResetBranding(t.db);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      branding: { orgName: null, primaryColor: null, coloredHeader: false, hasLogo: false },
    });
  });

  it("401s and 403s logo upload and removal", async () => {
    const png = LOGO_BYTES["png"] ?? new Uint8Array();
    jar.cookie = "";
    expect((await handleUploadLogo(logoRequest(png, String(png.length)), t.db)).status).toBe(401);
    expect((await handleRemoveLogo(t.db)).status).toBe(401);
    signInAs("user");
    expect((await handleUploadLogo(logoRequest(png, String(png.length)), t.db)).status).toBe(403);
    expect((await handleRemoveLogo(t.db)).status).toBe(403);
    signInAs("admin");
  });

  it("accepts each logo type, bumps the version on replace and removal", async () => {
    signInAs("admin");
    await t.db.delete(siteBranding);
    let version = 0;
    for (const type of ["png", "jpeg", "webp", "svg"] as const) {
      const bytes = LOGO_BYTES[type] ?? new Uint8Array();
      const response = await handleUploadLogo(logoRequest(bytes, String(bytes.length)), t.db);
      expect(response.status, type).toBe(200);
      const logo = await logoOf();
      expect(logo?.type).toBe(type);
      expect(logo?.version).toBeGreaterThan(version);
      version = logo?.version ?? version;
    }
    const removed = await handleRemoveLogo(t.db);
    expect(removed.status).toBe(200);
    expect(await logoOf()).toBeNull();
    expect(await removed.json()).toMatchObject({ branding: { hasLogo: false } });
  });

  it("rejects a renamed HTML file, an empty file, and an oversized body with a false Content-Length", async () => {
    signInAs("admin");
    await t.db.delete(siteBranding);
    const html = new TextEncoder().encode("<html><body>not an image</body></html>");
    expect((await handleUploadLogo(logoRequest(html, String(html.length)), t.db)).status).toBe(400);
    expect((await handleUploadLogo(logoRequest(new Uint8Array(0), "0"), t.db)).status).toBe(400);
    const big = new Uint8Array(600 * 1024).fill(0xff);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;
    expect((await handleUploadLogo(logoRequest(big, "100"), t.db)).status).toBe(413);
    expect(await logoOf()).toBeNull();
  });
});

function logoRequest(bytes: Uint8Array, contentLength: string | null): Request {
  const headers = new Headers();
  if (contentLength !== null) headers.set("content-length", contentLength);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { headers, body: stream } as unknown as Request;
}

const LOGO_BYTES: Record<string, Uint8Array> = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  webp: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  svg: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
};
