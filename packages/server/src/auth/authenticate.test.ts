import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_TENANT } from "@docmyrepos/core";

import { users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  SessionUserUnavailableError,
  issueSessionCookie,
  readCookie,
  sessionUser,
} from "./authenticate";
import { SESSION_COOKIE, newSessionPayload, signSession, verifySession } from "./session";

const SECRET = "session-secret-for-authenticate-tests";

function request(cookie: string | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", {
    headers: { ...headers, ...(cookie === null ? {} : { cookie }) },
  });
}

describe("readCookie", () => {
  it("finds a cookie among others and decodes it", () => {
    expect(readCookie("a=1; dmr_session=x.y; b=2", "dmr_session")).toBe("x.y");
    expect(readCookie("dmr_session=a%3Db", "dmr_session")).toBe("a=b");
    expect(readCookie("other=1", "dmr_session")).toBeUndefined();
    expect(readCookie(null, "dmr_session")).toBeUndefined();
    expect(readCookie("dmr_session=%E0%A4%A", "dmr_session")).toBe("%E0%A4%A");
  });
});

describe("session payloads", () => {
  it("keep the previous format for the built-in tenant: no tenant field", () => {
    const payload = newSessionPayload(7, "user", 2);
    expect(Object.keys(payload)).toEqual(["uid", "role", "exp", "pwv"]);
    // The signed value of a built-in tenant session is what the previous release wrote.
    const before = { uid: 7, role: "user" as const, exp: payload.exp, pwv: 2 };
    expect(signSession(SECRET, payload)).toBe(signSession(SECRET, before));
  });

  it("name any other tenant, and verify with the name kept", () => {
    const payload = newSessionPayload(7, "user", 2, "acme");
    expect(payload.tid).toBe("acme");
    expect(verifySession(SECRET, signSession(SECRET, payload))?.tid).toBe("acme");
  });
});

describeDb("the default authenticate", () => {
  let t: TestDatabase;
  let id: number;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.delete(users);
    const [row] = await t.db
      .insert(users)
      .values({ email: "ana@example.com", passwordHash: "x", role: "user" })
      .returning({ id: users.id });
    id = row!.id;
  });

  const cookieFor = (payload = newSessionPayload(id, "user", 0)) =>
    `${SESSION_COOKIE}=${signSession(SECRET, payload)}`;
  const authenticate = (req: Request, env: Record<string, string> = {}) =>
    sessionUser(req, DEFAULT_TENANT, { db: t.db, sessionSecret: SECRET, env });

  it("returns the user of a valid session cookie", async () => {
    expect(await authenticate(request(cookieFor()))).toEqual({
      id,
      email: "ana@example.com",
      role: "user",
    });
  });

  it("returns null without a cookie, with a forged one or an expired one", async () => {
    expect(await authenticate(request(null))).toBeNull();
    expect(await authenticate(request(`${SESSION_COOKIE}=forged.value`))).toBeNull();
    const expired = { ...newSessionPayload(id, "user", 0), exp: Date.now() - 1 };
    expect(await authenticate(request(cookieFor(expired)))).toBeNull();
  });

  it("returns null once the user is disabled, or their password or role changed", async () => {
    const cookie = cookieFor();
    await t.db.update(users).set({ disabled: true }).where(eq(users.id, id));
    expect(await authenticate(request(cookie))).toBeNull();
    await t.db.update(users).set({ disabled: false, pwVersion: 1 }).where(eq(users.id, id));
    expect(await authenticate(request(cookie))).toBeNull();
    await t.db.update(users).set({ pwVersion: 0, role: "admin" }).where(eq(users.id, id));
    expect(await authenticate(request(cookie))).toBeNull();
  });

  it("under the e2e switch, is the fixed admin, or the user named in x-e2e-user", async () => {
    const env = { E2E_AUTH_BYPASS: "1" };
    expect(await authenticate(request(null), env)).toEqual({
      id: 0,
      email: "e2e-admin@example.com",
      role: "admin",
    });
    expect(await authenticate(request(null, { "x-e2e-user": "ANA@example.com" }), env)).toEqual({
      id,
      email: "ana@example.com",
      role: "user",
    });
  });

  it("accepts a session only for the tenant it was issued for", async () => {
    const acme = { id: "acme", attributes: {} };
    const other = { id: "other", attributes: {} };
    const forAcme = cookieFor(newSessionPayload(id, "user", 0, "acme"));
    const deps = { db: t.db, sessionSecret: SECRET, env: {} };
    expect(await sessionUser(request(forAcme), acme, deps)).toMatchObject({ id });
    // Same user id in another tenant's database: still not this tenant's session.
    expect(await sessionUser(request(forAcme), other, deps)).toBeNull();
    expect(await sessionUser(request(forAcme), DEFAULT_TENANT, deps)).toBeNull();
    // A cookie that names no tenant belongs to the built-in tenant only.
    expect(await sessionUser(request(cookieFor()), acme, deps)).toBeNull();
    expect(await sessionUser(request(cookieFor()), DEFAULT_TENANT, deps)).toMatchObject({ id });
  });

  it("issues a session for a host's own sign-in, valid for its tenant only", async () => {
    const acme = { id: "acme", attributes: {} };
    const header = await issueSessionCookie(t.db, acme, id, {
      sessionSecret: SECRET,
      secure: true,
    });
    expect(header).toMatch(/^dmr_session=[^;]+; .*HttpOnly/);
    expect(header).toContain("Secure");
    const cookie = header.split(";")[0] as string;
    const deps = { db: t.db, sessionSecret: SECRET, env: {} };
    expect(await sessionUser(request(cookie), acme, deps)).toMatchObject({ id });
    expect(await sessionUser(request(cookie), DEFAULT_TENANT, deps)).toBeNull();
    await t.db.update(users).set({ disabled: true }).where(eq(users.id, id));
    await expect(
      issueSessionCookie(t.db, acme, id, { sessionSecret: SECRET, secure: true }),
    ).rejects.toBeInstanceOf(SessionUserUnavailableError);
  });
});
