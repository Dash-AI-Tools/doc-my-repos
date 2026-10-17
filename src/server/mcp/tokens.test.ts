import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { apiTokens, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  EXPIRY_CHOICES_DAYS,
  LAST_USED_INTERVAL_SECONDS,
  MAX_ACTIVE_TOKENS,
  RETENTION_DAYS,
  TOKEN_PREFIX,
  createToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  listAllTokens,
  listTokens,
  parseTokenName,
  revokeToken,
  verifyToken,
} from "./tokens";

describe("token generation", () => {
  it("makes dmr_ plus 32 random bytes in base64url, with a hash and a display prefix", () => {
    const { token, hash, prefix } = generateToken();
    expect(token).toMatch(/^dmr_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(token)).toBe(true);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prefix).toHaveLength(8);
    expect(token.startsWith(`${TOKEN_PREFIX}${prefix}`)).toBe(true);
    // The hash and the prefix do not reveal the rest of the token.
    expect(hash).not.toContain(token.slice(4, 20));
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(seen.size).toBe(200);
  });

  it("recognizes only the exact shape", () => {
    const { token } = generateToken();
    for (const bad of [
      "",
      "dmr_",
      token.slice(0, -1),
      `${token}x`,
      ` ${token}`,
      `${token}\n`,
      token.replace("dmr_", "xxx_"),
      token.replace(/.$/, "!"),
      "Bearer " + token,
    ]) {
      expect(isWellFormedToken(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("token names", () => {
  it("accepts 1 to 60 plain-text characters, trimmed", () => {
    expect(parseTokenName("laptop")).toBe("laptop");
    expect(parseTokenName("  my agent  ")).toBe("my agent");
    expect(parseTokenName("x".repeat(60))).toBe("x".repeat(60));
    expect(parseTokenName("Ünïcödé 日本語")).toBe("Ünïcödé 日本語");
    // Counted in characters, not UTF-16 units.
    expect(parseTokenName("😀".repeat(60))).toBe("😀".repeat(60));
  });

  it("rejects empty, blank, long, non-text and control characters", () => {
    for (const bad of [
      "",
      "   ",
      "x".repeat(61),
      "😀".repeat(61),
      "a\nb",
      "a\u0000b",
      "a‮b",
      "a b",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(parseTokenName(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describeDb("API tokens in the database", () => {
  let t: TestDatabase;
  let alice: number;
  let bob: number;
  let admin: number;

  beforeAll(async () => {
    t = await createTestDatabase();
    const rows = await t.db
      .insert(users)
      .values([
        { email: "alice@example.com", passwordHash: "x" },
        { email: "bob@example.com", passwordHash: "x" },
        { email: "admin@example.com", passwordHash: "x", role: "admin" },
      ])
      .returning({ id: users.id });
    alice = rows[0]!.id;
    bob = rows[1]!.id;
    admin = rows[2]!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const clear = () => t.db.delete(apiTokens);
  const create = async (userId: number, name = "laptop", expiryDays: unknown = 90) => {
    const result = await createToken(t.db, userId, { name, expiryDays });
    if (!result.ok) throw new Error(`create failed: ${result.error}`);
    return result;
  };

  describe("createToken", () => {
    it("returns the full token once, with a view of name, prefix and expiry", async () => {
      await clear();
      const before = Date.now();
      const created = await create(alice, "laptop", 90);
      expect(created.token).toMatch(/^dmr_[A-Za-z0-9_-]{43}$/);
      expect(created.view).toMatchObject({
        name: "laptop",
        status: "active",
        lastUsedAt: null,
        revokedAt: null,
      });
      expect(created.view.prefix).toBe(created.token.slice(4, 12));
      const expected = before + 90 * 24 * 60 * 60 * 1000;
      expect(Math.abs(created.view.expiresAt.getTime() - expected)).toBeLessThan(10_000);
      // The view carries no secret material.
      expect(JSON.stringify(created.view)).not.toContain(created.token);
      expect(JSON.stringify(created.view)).not.toContain(hashToken(created.token));
    });

    it("accepts exactly 30, 90 and 365 days", async () => {
      await clear();
      for (const days of EXPIRY_CHOICES_DAYS) {
        const created = await create(alice, `t${days}`, days);
        const delta = created.view.expiresAt.getTime() - Date.now();
        expect(Math.abs(delta - days * 86_400_000)).toBeLessThan(10_000);
      }
      for (const bad of [0, 1, 7, 60, 366, "90", null, undefined, 90.5]) {
        const r = await createToken(t.db, alice, { name: "x", expiryDays: bad });
        expect(r, String(bad)).toMatchObject({ ok: false, status: 400 });
        if (!r.ok) expect(r.error).toContain("expiryDays");
      }
    });

    it("refuses a bad name, naming the field, and creates nothing", async () => {
      await clear();
      for (const name of ["", "   ", "x".repeat(61), "a\nb", 5, null]) {
        const r = await createToken(t.db, alice, { name, expiryDays: 30 });
        expect(r, JSON.stringify(name)).toMatchObject({ ok: false, status: 400 });
        if (!r.ok) expect(r.error).toContain("name");
      }
      expect(await t.db.select().from(apiTokens)).toEqual([]);
    });

    it("stores only the hash and the prefix, never the token", async () => {
      await clear();
      const created = await create(alice);
      const rows = await t.db.select().from(apiTokens);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(hashToken(created.token));
      expect(rows[0]!.prefix).toBe(created.token.slice(4, 12));
      expect(JSON.stringify(rows)).not.toContain(created.token);
      const dump = await t.pool.query("SELECT row_to_json(api_tokens)::text AS j FROM api_tokens");
      expect(String(dump.rows[0]?.j)).not.toContain(created.token.slice(12));
    });

    it("refuses the eleventh active token and creates nothing", async () => {
      await clear();
      for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) await create(alice, `t${i}`);
      const r = await createToken(t.db, alice, { name: "one too many", expiryDays: 30 });
      expect(r).toMatchObject({ ok: false, status: 409 });
      if (!r.ok) expect(r.error).toContain("limit");
      expect(await listTokens(t.db, alice)).toHaveLength(MAX_ACTIVE_TOKENS);
      // Another user is unaffected.
      await create(bob, "mine");
    });

    it("counts only active tokens: revoked and expired ones free a slot", async () => {
      await clear();
      const made = [];
      for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) made.push(await create(alice, `t${i}`));
      expect(await revokeToken(t.db, made[0]!.view.id, { id: alice, role: "user" })).toEqual({
        ok: true,
      });
      await t.db
        .update(apiTokens)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(apiTokens.id, made[1]!.view.id));
      await create(alice, "after revoke");
      await create(alice, "after expiry");
      const r = await createToken(t.db, alice, { name: "full again", expiryDays: 30 });
      expect(r).toMatchObject({ ok: false, status: 409 });
    });

    it("cannot exceed the limit when created at the same moment", async () => {
      await clear();
      for (let i = 0; i < MAX_ACTIVE_TOKENS - 1; i++) await create(alice, `t${i}`);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          createToken(t.db, alice, { name: `race${i}`, expiryDays: 30 }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await listTokens(t.db, alice)).toHaveLength(MAX_ACTIVE_TOKENS);
    });

    it("refuses an unknown user", async () => {
      const r = await createToken(t.db, 987_654, { name: "x", expiryDays: 30 });
      expect(r).toMatchObject({ ok: false, status: 400 });
    });

    it("purges rows revoked or expired more than 30 days ago, keeping newer ones", async () => {
      await clear();
      const old = await create(bob, "old revoked");
      const olderExpired = await create(bob, "old expired");
      const recent = await create(bob, "recent revoked");
      await t.db
        .update(apiTokens)
        .set({ revokedAt: sql`now() - make_interval(days => ${RETENTION_DAYS + 1})` })
        .where(eq(apiTokens.id, old.view.id));
      await t.db
        .update(apiTokens)
        .set({ expiresAt: sql`now() - make_interval(days => ${RETENTION_DAYS + 2})` })
        .where(eq(apiTokens.id, olderExpired.view.id));
      await t.db
        .update(apiTokens)
        .set({ revokedAt: sql`now() - make_interval(days => ${RETENTION_DAYS - 1})` })
        .where(eq(apiTokens.id, recent.view.id));
      await create(alice, "trigger the purge");
      const left = (await t.db.select().from(apiTokens)).map((r) => r.name).sort();
      expect(left).toEqual(["recent revoked", "trigger the purge"]);
    });
  });

  describe("listTokens and listAllTokens", () => {
    it("lists a user's own tokens, newest first, with status and no secret", async () => {
      await clear();
      const first = await create(alice, "first");
      const second = await create(alice, "second");
      await create(bob, "bobs");
      await revokeToken(t.db, first.view.id, { id: alice, role: "user" });
      const list = await listTokens(t.db, alice);
      expect(list.map((x) => [x.name, x.status])).toEqual([
        ["second", "active"],
        ["first", "revoked"],
      ]);
      const text = JSON.stringify(list);
      for (const c of [first, second]) {
        expect(text).not.toContain(c.token);
        expect(text).not.toContain(hashToken(c.token));
      }
      expect(Object.keys(list[0]!).sort()).toEqual(
        [
          "createdAt",
          "expiresAt",
          "id",
          "lastUsedAt",
          "name",
          "prefix",
          "revokedAt",
          "status",
        ].sort(),
      );
    });

    it("shows expired tokens as expired and hides rows ended over 30 days ago", async () => {
      await clear();
      const soon = await create(alice, "expired just now");
      const gone = await create(alice, "expired long ago");
      await t.db
        .update(apiTokens)
        .set({ expiresAt: sql`now() - interval '1 hour'` })
        .where(eq(apiTokens.id, soon.view.id));
      await t.db
        .update(apiTokens)
        .set({ expiresAt: sql`now() - make_interval(days => ${RETENTION_DAYS + 1})` })
        .where(eq(apiTokens.id, gone.view.id));
      expect((await listTokens(t.db, alice)).map((x) => [x.name, x.status])).toEqual([
        ["expired just now", "expired"],
      ]);
    });

    it("lists every user's tokens with the owner for an admin", async () => {
      await clear();
      await create(alice, "a1");
      await create(bob, "b1");
      const all = await listAllTokens(t.db);
      expect(all.map((x) => [x.owner.email, x.name]).sort()).toEqual([
        ["alice@example.com", "a1"],
        ["bob@example.com", "b1"],
      ]);
      expect(Object.keys(all[0]!)).toContain("owner");
      expect(JSON.stringify(all)).not.toMatch(/dmr_/);
    });
  });

  describe("revokeToken", () => {
    it("lets a user revoke their own token, effective at once", async () => {
      await clear();
      const c = await create(alice);
      expect((await verifyToken(t.db, c.token)).ok).toBe(true);
      expect(await revokeToken(t.db, c.view.id, { id: alice, role: "user" })).toEqual({ ok: true });
      expect(await verifyToken(t.db, c.token)).toEqual({ ok: false, reason: "revoked" });
    });

    it("answers not found for another user's token and leaves it working", async () => {
      await clear();
      const c = await create(bob);
      expect(await revokeToken(t.db, c.view.id, { id: alice, role: "user" })).toEqual({
        ok: false,
        status: 404,
      });
      expect((await verifyToken(t.db, c.token)).ok).toBe(true);
      expect(await revokeToken(t.db, 999_999, { id: alice, role: "user" })).toEqual({
        ok: false,
        status: 404,
      });
    });

    it("lets an admin revoke anyone's token, and the owner sees it as revoked", async () => {
      await clear();
      const c = await create(bob, "bobs laptop");
      expect(await revokeToken(t.db, c.view.id, { id: admin, role: "admin" })).toEqual({
        ok: true,
      });
      expect(await verifyToken(t.db, c.token)).toEqual({ ok: false, reason: "revoked" });
      expect((await listTokens(t.db, bob))[0]).toMatchObject({
        name: "bobs laptop",
        status: "revoked",
      });
    });

    it("keeps the first revocation time when revoked twice", async () => {
      await clear();
      const c = await create(alice);
      await revokeToken(t.db, c.view.id, { id: alice, role: "user" });
      const [first] = await t.db.select().from(apiTokens);
      await revokeToken(t.db, c.view.id, { id: alice, role: "user" });
      const [second] = await t.db.select().from(apiTokens);
      expect(second!.revokedAt!.getTime()).toBe(first!.revokedAt!.getTime());
    });
  });

  describe("verifyToken", () => {
    it("accepts a valid token and returns its user, never the token", async () => {
      await clear();
      const c = await create(alice);
      const r = await verifyToken(t.db, c.token);
      expect(r).toEqual({
        ok: true,
        tokenId: c.view.id,
        user: { id: alice, email: "alice@example.com", role: "user" },
      });
      expect(JSON.stringify(r)).not.toContain(c.token);
    });

    it("gives an admin's token the admin role as data but only the MCP endpoint reads it", async () => {
      await clear();
      const c = await create(admin);
      const r = await verifyToken(t.db, c.token);
      expect(r.ok && r.user.role).toBe("admin");
    });

    it.each([
      ["a malformed value", "not-a-token", "malformed"],
      ["an empty value", "", "malformed"],
      ["a well-formed unknown token", generateToken().token, "unknown"],
    ])("rejects %s", async (_label, presented, reason) => {
      await clear();
      await create(alice);
      expect(await verifyToken(t.db, presented)).toEqual({ ok: false, reason });
    });

    it("rejects an expired token", async () => {
      await clear();
      const c = await create(alice);
      expect((await verifyToken(t.db, c.token)).ok).toBe(true);
      await t.db
        .update(apiTokens)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(apiTokens.id, c.view.id));
      expect(await verifyToken(t.db, c.token)).toEqual({ ok: false, reason: "expired" });
      // And by the clock passed in, for a token that has not expired in the database yet.
      const d = await create(alice, "later");
      const farFuture = new Date(Date.now() + 91 * 86_400_000);
      expect(await verifyToken(t.db, d.token, farFuture)).toEqual({ ok: false, reason: "expired" });
    });

    it("rejects the tokens of a disabled user at once, and accepts them again when enabled", async () => {
      await clear();
      const c = await create(bob);
      await t.db.update(users).set({ disabled: true }).where(eq(users.id, bob));
      expect(await verifyToken(t.db, c.token)).toEqual({ ok: false, reason: "disabled" });
      await t.db.update(users).set({ disabled: false }).where(eq(users.id, bob));
      expect((await verifyToken(t.db, c.token)).ok).toBe(true);
    });

    it("rejects tokens created before the user's tokens_valid_after and accepts newer ones", async () => {
      await clear();
      const before = await create(bob, "before reset");
      await t.db
        .update(users)
        .set({ tokensValidAfter: sql`now()` })
        .where(eq(users.id, bob));
      expect(await verifyToken(t.db, before.token)).toEqual({ ok: false, reason: "reset" });
      const after = await create(bob, "after reset");
      expect((await verifyToken(t.db, after.token)).ok).toBe(true);
      await t.db.update(users).set({ tokensValidAfter: null }).where(eq(users.id, bob));
    });

    it("rejects a token whose user was removed", async () => {
      await clear();
      const [temp] = await t.db
        .insert(users)
        .values({ email: "temp@example.com", passwordHash: "x" })
        .returning({ id: users.id });
      const c = await create(temp!.id);
      await t.db.delete(users).where(eq(users.id, temp!.id));
      expect(await verifyToken(t.db, c.token)).toEqual({ ok: false, reason: "unknown" });
    });

    it("writes last_used_at at most once a minute", async () => {
      await clear();
      const c = await create(alice);
      const lastUsed = async () =>
        (await t.db.select().from(apiTokens).where(eq(apiTokens.id, c.view.id)))[0]!.lastUsedAt;
      expect(await lastUsed()).toBeNull();
      await verifyToken(t.db, c.token);
      const first = await lastUsed();
      expect(first).toBeInstanceOf(Date);
      // Within the interval: not written again.
      await verifyToken(t.db, c.token);
      await verifyToken(t.db, c.token);
      expect((await lastUsed())!.getTime()).toBe(first!.getTime());
      // Past the interval: written.
      await t.db
        .update(apiTokens)
        .set({
          lastUsedAt: sql`now() - make_interval(secs => ${LAST_USED_INTERVAL_SECONDS + 5})`,
        })
        .where(eq(apiTokens.id, c.view.id));
      const stale = await lastUsed();
      await verifyToken(t.db, c.token);
      expect((await lastUsed())!.getTime()).toBeGreaterThan(stale!.getTime());
    });

    it("does not fail the request when the last-use write fails", async () => {
      await clear();
      const c = await create(alice);
      const spy = vi.spyOn(t.db, "update").mockImplementation(() => {
        throw new Error("write failed");
      });
      try {
        expect((await verifyToken(t.db, c.token)).ok).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not reveal which part of a token matched: only fixed reason words come back", async () => {
      await clear();
      const c = await create(alice);
      const nearMiss = c.token.slice(0, -1) + (c.token.endsWith("A") ? "B" : "A");
      const results = [
        await verifyToken(t.db, nearMiss),
        await verifyToken(t.db, generateToken().token),
      ];
      expect(results).toEqual([
        { ok: false, reason: "unknown" },
        { ok: false, reason: "unknown" },
      ]);
    });
  });
});
