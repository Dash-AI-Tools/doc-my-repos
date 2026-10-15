import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { siteBranding, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { hashPassword } from "../auth/password";
import { newSessionPayload, SESSION_COOKIE, signSession } from "../auth/session";
import { handleGetBranding, handleResetBranding, handleUpdateBranding } from "./service";

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

    const reset = await handleResetBranding(t.db);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      branding: { orgName: null, primaryColor: null, coloredHeader: false, hasLogo: false },
    });
  });
});
