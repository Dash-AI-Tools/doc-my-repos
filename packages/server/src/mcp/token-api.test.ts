import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "../auth/current-user";
import type { Db } from "../db/client";
import { apiTokens, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import type { Logger } from "../log";
import {
  MAX_BODY_CHARS,
  handleCreateToken,
  handleListAllTokens,
  handleListOwnTokens,
  handleRevokeAnyToken,
  handleRevokeOwnToken,
  type TokenApiDeps,
} from "./token-api";
import { MAX_ACTIVE_TOKENS, hashToken } from "./tokens";

// With no session cookie on the request, the real `requireUser` / `requireAdmin` answer 401.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ORIGIN = "http://portal.test";

function recorder() {
  const lines: { event: string; fields: unknown }[] = [];
  const log: Logger = {
    debug: () => undefined,
    info: (event, fields) => void lines.push({ event, fields }),
    warn: (event, fields) => void lines.push({ event, fields }),
    error: (event, fields) => void lines.push({ event, fields }),
    child: () => log,
  };
  return { log, lines };
}

const jsonRequest = (method: string, path: string, body?: unknown, headers: HeadersInit = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describeDb("token management APIs", () => {
  let t: TestDatabase;
  let alice: CurrentUser;
  let bob: CurrentUser;
  let admin: CurrentUser;
  let log: ReturnType<typeof recorder>;

  beforeAll(async () => {
    t = await createTestDatabase();
    const rows = await t.db
      .insert(users)
      .values([
        { email: "alice@example.com", passwordHash: "x" },
        { email: "bob@example.com", passwordHash: "x" },
        { email: "admin@example.com", passwordHash: "x", role: "admin" },
      ])
      .returning();
    const as = (i: number): CurrentUser => ({
      id: rows[i]!.id,
      email: rows[i]!.email,
      role: rows[i]!.role,
    });
    alice = as(0);
    bob = as(1);
    admin = as(2);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.delete(apiTokens);
    log = recorder();
  });

  const deps = (user: CurrentUser | "none", over: Partial<TokenApiDeps> = {}): TokenApiDeps => ({
    db: t.db as Db,
    enabled: () => true,
    log: log.log,
    user:
      user === "none"
        ? async () => {
            throw Object.assign(new Error("unauthorized"), { status: 401 });
          }
        : async () => user,
    ...over,
  });

  async function make(user: CurrentUser, name = "laptop", expiryDays = 90) {
    const res = await handleCreateToken(
      jsonRequest("POST", "/api/account/tokens", { name, expiryDays }),
      deps(user),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; view: { id: number; name: string } };
  }

  describe("creating and listing", () => {
    it("creates a token, returning the full token once and never caching it", async () => {
      const res = await handleCreateToken(
        jsonRequest("POST", "/api/account/tokens", { name: "laptop", expiryDays: 90 }),
        deps(alice),
      );
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { token: string; view: Record<string, unknown> };
      expect(body.token).toMatch(/^dmr_[A-Za-z0-9_-]{43}$/);
      expect(body.view).toMatchObject({ name: "laptop", status: "active" });
      expect(JSON.stringify(body.view)).not.toContain(body.token);
    });

    it("lists only the signed-in user's tokens, without any secret", async () => {
      const mine = await make(alice, "mine");
      await make(bob, "bobs");
      const res = await handleListOwnTokens(jsonRequest("GET", "/api/account/tokens"), deps(alice));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text) as { tokens: { name: string }[] };
      expect(body.tokens.map((x) => x.name)).toEqual(["mine"]);
      expect(text).not.toContain(mine.token);
      expect(text).not.toContain(hashToken(mine.token));
    });

    it("refuses an invalid name or expiry with a 400 naming the field, creating nothing", async () => {
      for (const [body, field] of [
        [{ name: "", expiryDays: 30 }, "name"],
        [{ name: "x".repeat(61), expiryDays: 30 }, "name"],
        [{ name: "ok", expiryDays: 7 }, "expiryDays"],
        [{ name: "ok", expiryDays: "30" }, "expiryDays"],
        [{ expiryDays: 30 }, "name"],
        [{ name: "ok" }, "expiryDays"],
      ] as const) {
        const res = await handleCreateToken(
          jsonRequest("POST", "/api/account/tokens", body),
          deps(alice),
        );
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(field);
      }
      expect(await t.db.select().from(apiTokens)).toEqual([]);
    });

    it("refuses an invalid body: not JSON, not an object, too large", async () => {
      const post = (text: string) =>
        handleCreateToken(
          new Request(`${ORIGIN}/api/account/tokens`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: text,
          }),
          deps(alice),
        );
      expect((await post("{nope")).status).toBe(400);
      expect((await post("[]")).status).toBe(400);
      expect((await post("null")).status).toBe(400);
      expect((await post("")).status).toBe(400);
      expect((await post(JSON.stringify({ name: "x".repeat(MAX_BODY_CHARS) }))).status).toBe(413);
      expect(await t.db.select().from(apiTokens)).toEqual([]);
    });

    it("refuses the eleventh active token with a 409 naming the limit", async () => {
      for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) await make(alice, `t${i}`);
      const res = await handleCreateToken(
        jsonRequest("POST", "/api/account/tokens", { name: "extra", expiryDays: 30 }),
        deps(alice),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("limit");
    });
  });

  describe("revoking", () => {
    it("revokes the user's own token", async () => {
      const mine = await make(alice);
      const res = await handleRevokeOwnToken(
        jsonRequest("DELETE", `/api/account/tokens/${mine.view.id}`),
        String(mine.view.id),
        deps(alice),
      );
      expect(res.status).toBe(200);
      const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, mine.view.id));
      expect(row?.revokedAt).toBeInstanceOf(Date);
    });

    it("answers 404 for another user's token and leaves it active", async () => {
      const bobs = await make(bob);
      const res = await handleRevokeOwnToken(
        jsonRequest("DELETE", `/api/account/tokens/${bobs.view.id}`),
        String(bobs.view.id),
        deps(alice),
      );
      expect(res.status).toBe(404);
      const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, bobs.view.id));
      expect(row?.revokedAt).toBeNull();
    });

    it.each(["abc", "0", "-1", "1.5", "99999999999", "1e3", " 1", "1 ", ""])(
      "answers 404 for the id %j",
      async (raw) => {
        const res = await handleRevokeOwnToken(
          jsonRequest("DELETE", "/api/account/tokens/x"),
          raw,
          deps(alice),
        );
        expect(res.status).toBe(404);
      },
    );
  });

  describe("administrators", () => {
    it("lists every user's tokens with the owner, and revokes any of them", async () => {
      const bobs = await make(bob, "bobs laptop");
      await make(alice, "alices");
      const list = await handleListAllTokens(jsonRequest("GET", "/api/admin/tokens"), deps(admin));
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        tokens: { name: string; owner: { email: string } }[];
      };
      expect(body.tokens.map((x) => [x.owner.email, x.name]).sort()).toEqual([
        ["alice@example.com", "alices"],
        ["bob@example.com", "bobs laptop"],
      ]);

      const res = await handleRevokeAnyToken(
        jsonRequest("DELETE", `/api/admin/tokens/${bobs.view.id}`),
        String(bobs.view.id),
        deps(admin),
      );
      expect(res.status).toBe(200);
      const own = await handleListOwnTokens(jsonRequest("GET", "/api/account/tokens"), deps(bob));
      const mine = (await own.json()) as { tokens: { status: string }[] };
      expect(mine.tokens.map((x) => x.status)).toEqual(["revoked"]);
    });

    it("answers 404 for an unknown token id", async () => {
      const res = await handleRevokeAnyToken(
        jsonRequest("DELETE", "/api/admin/tokens/999999"),
        "999999",
        deps(admin),
      );
      expect(res.status).toBe(404);
    });

    it("refuses a signed-in non-admin with 403 on both admin routes and changes nothing", async () => {
      const bobs = await make(bob);
      const list = await handleListAllTokens(jsonRequest("GET", "/api/admin/tokens"), deps(alice));
      expect(list.status).toBe(403);
      const revoke = await handleRevokeAnyToken(
        jsonRequest("DELETE", `/api/admin/tokens/${bobs.view.id}`),
        String(bobs.view.id),
        deps(alice),
      );
      expect(revoke.status).toBe(403);
      const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, bobs.view.id));
      expect(row?.revokedAt).toBeNull();
    });
  });

  describe("who may call", () => {
    it("answers 401 to a signed-out request on every route", async () => {
      const none = deps("none");
      const results = await Promise.all([
        handleListOwnTokens(jsonRequest("GET", "/api/account/tokens"), none),
        handleCreateToken(
          jsonRequest("POST", "/api/account/tokens", { name: "x", expiryDays: 30 }),
          none,
        ),
        handleRevokeOwnToken(jsonRequest("DELETE", "/api/account/tokens/1"), "1", none),
        handleListAllTokens(jsonRequest("GET", "/api/admin/tokens"), none),
        handleRevokeAnyToken(jsonRequest("DELETE", "/api/admin/tokens/1"), "1", none),
      ]);
      expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    });

    it("answers 401 when only an API token is presented: tokens cannot manage tokens", async () => {
      const existing = await make(alice, "agent");
      const auth = { authorization: `Bearer ${existing.token}` };
      // No `user` override: the real session check runs, finds no cookie, and refuses.
      const real: TokenApiDeps = { db: t.db as Db, enabled: () => true, log: log.log };
      const results = await Promise.all([
        handleListOwnTokens(jsonRequest("GET", "/api/account/tokens", undefined, auth), real),
        handleCreateToken(
          jsonRequest("POST", "/api/account/tokens", { name: "x", expiryDays: 30 }, auth),
          real,
        ),
        handleRevokeOwnToken(
          jsonRequest("DELETE", `/api/account/tokens/${existing.view.id}`, undefined, auth),
          String(existing.view.id),
          real,
        ),
        handleListAllTokens(jsonRequest("GET", "/api/admin/tokens", undefined, auth), real),
        handleRevokeAnyToken(
          jsonRequest("DELETE", `/api/admin/tokens/${existing.view.id}`, undefined, auth),
          String(existing.view.id),
          real,
        ),
      ]);
      expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
      const rows = await t.db.select().from(apiTokens);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).toBeNull();
      // The presented token is not logged either.
      expect(JSON.stringify(log.lines)).not.toContain(existing.token);
    });

    it("answers 404 on every route when the MCP endpoint is off, signed in or not", async () => {
      const off = (user: CurrentUser | "none") => deps(user, { enabled: () => false });
      for (const user of [alice, admin, "none"] as const) {
        const d = off(user);
        const results = await Promise.all([
          handleListOwnTokens(jsonRequest("GET", "/api/account/tokens"), d),
          handleCreateToken(
            jsonRequest("POST", "/api/account/tokens", { name: "x", expiryDays: 30 }),
            d,
          ),
          handleRevokeOwnToken(jsonRequest("DELETE", "/api/account/tokens/1"), "1", d),
          handleListAllTokens(jsonRequest("GET", "/api/admin/tokens"), d),
          handleRevokeAnyToken(jsonRequest("DELETE", "/api/admin/tokens/1"), "1", d),
        ]);
        expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
      }
      expect(await t.db.select().from(apiTokens)).toEqual([]);
    });

    it("answers 503 when the switch cannot be read, revealing nothing", async () => {
      const res = await handleListOwnTokens(
        jsonRequest("GET", "/api/account/tokens"),
        deps(alice, {
          enabled: () => {
            throw new Error("db down: password=hunter2");
          },
        }),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain("hunter2");
    });
  });

  describe("same-origin writes", () => {
    const create = (headers: HeadersInit, contentType = "application/json") =>
      handleCreateToken(
        new Request(`${ORIGIN}/api/account/tokens`, {
          method: "POST",
          headers: { "content-type": contentType, ...headers },
          body: JSON.stringify({ name: "x", expiryDays: 30 }),
        }),
        deps(alice),
      );

    it("refuses a foreign Origin, a cross-site fetch and a non-JSON body with 403", async () => {
      expect((await create({ origin: "https://evil.example" })).status).toBe(403);
      expect((await create({ "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await create({}, "text/plain")).status).toBe(403);
      expect(await t.db.select().from(apiTokens)).toEqual([]);
    });

    it("accepts the portal's own Origin and a request with none", async () => {
      expect((await create({ origin: ORIGIN })).status).toBe(201);
      expect((await create({})).status).toBe(201);
    });

    it("applies to revoking, too", async () => {
      const mine = await make(alice);
      const res = await handleRevokeOwnToken(
        new Request(`${ORIGIN}/api/account/tokens/${mine.view.id}`, {
          method: "DELETE",
          headers: { origin: "https://evil.example", "content-type": "application/json" },
        }),
        String(mine.view.id),
        deps(alice),
      );
      expect(res.status).toBe(403);
      const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, mine.view.id));
      expect(row?.revokedAt).toBeNull();
    });
  });

  describe("logs and failures", () => {
    it("logs the action and ids, never a token, a name or an email", async () => {
      const created = await make(alice, "my secret laptop name");
      await handleRevokeOwnToken(
        jsonRequest("DELETE", `/api/account/tokens/${created.view.id}`),
        String(created.view.id),
        deps(alice),
      );
      expect(log.lines.map((l) => l.event)).toEqual(["mcp.token.created", "mcp.token.revoked"]);
      const text = JSON.stringify(log.lines);
      expect(text).not.toContain(created.token);
      expect(text).not.toContain(created.token.slice(4));
      expect(text).not.toContain("my secret laptop name");
      expect(text).not.toContain("alice@example.com");
      expect(log.lines[0]?.fields).toEqual({ ref: created.view.id, userId: alice.id });
    });

    it("answers 503 with a fixed message when the database fails, never its error", async () => {
      const broken = {
        transaction: () => {
          throw new Error("connection refused: postgres://u:pw@db/x");
        },
        select: () => {
          throw new Error("connection refused: postgres://u:pw@db/x");
        },
      } as unknown as Db;
      const create = await handleCreateToken(
        jsonRequest("POST", "/api/account/tokens", { name: "x", expiryDays: 30 }),
        deps(alice, { db: broken }),
      );
      const list = await handleListOwnTokens(
        jsonRequest("GET", "/api/account/tokens"),
        deps(alice, { db: broken }),
      );
      for (const res of [create, list]) {
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(text).not.toContain("postgres://");
        expect(text).not.toContain("pw@");
      }
    });
  });
});
