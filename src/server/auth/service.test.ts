import { afterAll, beforeAll, expect, it } from "vitest";

import { users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { hashPassword } from "./password";
import { newSessionPayload, signSession } from "./session";
import { handleLogin, handleLogout } from "./service";

const SECRET = "service-test-session-secret-0123456789";

function loginRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describeDb("auth routes", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(users).values({
      email: "admin@example.com",
      passwordHash: await hashPassword("admin-pass-1234"),
      role: "admin",
    });
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("logs in with valid credentials and sets a verifiable session cookie", async () => {
    const response = await handleLogin(
      loginRequest({ email: "admin@example.com", password: "admin-pass-1234" }),
      { db: t.db, sessionSecret: SECRET, bootstrap: null },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, role: "admin" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("dmr_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const value = /dmr_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    const { verifySession } = await import("./session");
    expect(verifySession(SECRET, value)).toMatchObject({ role: "admin", pwv: 0 });
  });

  it("answers generic 401 for bad credentials, unknown users, and broken JSON", async () => {
    for (const body of [
      { email: "admin@example.com", password: "wrong" },
      { email: "nobody@example.com", password: "admin-pass-1234" },
      "{not json",
    ]) {
      const response = await handleLogin(loginRequest(body), {
        db: t.db,
        sessionSecret: SECRET,
        bootstrap: null,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Invalid email or password" });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("refuses to start without a session secret", async () => {
    const response = await handleLogin(loginRequest({ email: "a", password: "b" }), {
      db: t.db,
      sessionSecret: "",
      bootstrap: null,
    });
    expect(response.status).toBe(500);
  });

  it("logs out by clearing the cookie", async () => {
    const signed = signSession(SECRET, newSessionPayload(1, "admin", 0));
    const response = await handleLogout();
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("dmr_session=;");
    expect(cookie).not.toContain(signed);
  });
});
