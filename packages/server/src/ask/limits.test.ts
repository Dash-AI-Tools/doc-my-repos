import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { askUsage, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  AskGate,
  DAY_SECONDS,
  TEN_MINUTES_SECONDS,
  checkWindows,
  claimAnonymousQuestion,
  estimateTokens,
  finishUsage,
  startUsage,
} from "./limits";

describe("AskGate for anonymous visitors", () => {
  it("has no one-at-a-time rule per person, only the process-wide cap", () => {
    const gate = new AskGate();
    const first = gate.tryEnterAnonymous(2);
    const second = gate.tryEnterAnonymous(2);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(gate.tryEnterAnonymous(2)).toEqual({ ok: false, reason: "server_busy" });
    if (first.ok) first.release();
    expect(gate.active).toBe(1);
    expect(gate.tryEnterAnonymous(2).ok).toBe(true);
  });

  it("counts toward the same cap as signed-in users, per tenant key, and releases once", () => {
    const gate = new AskGate();
    const user = gate.tryEnter(1, 2);
    const anon = gate.tryEnterAnonymous(2);
    expect(gate.tryEnter(2, 2)).toEqual({ ok: false, reason: "server_busy" });
    if (anon.ok) {
      anon.release();
      anon.release();
    }
    expect(gate.active).toBe(1);
    if (user.ok) user.release();
    expect(gate.active).toBe(0);
  });
});

describe("AskGate", () => {
  it("allows one answer per user and refuses a second until the first is released", () => {
    const gate = new AskGate();
    const first = gate.tryEnter(1, 8);
    expect(first.ok).toBe(true);
    expect(gate.tryEnter(1, 8)).toEqual({ ok: false, reason: "user_busy" });
    if (first.ok) first.release();
    expect(gate.tryEnter(1, 8).ok).toBe(true);
  });

  it("caps answers in the process and frees a place on release", () => {
    const gate = new AskGate();
    const slots = [1, 2, 3].map((id) => gate.tryEnter(id, 3));
    expect(slots.every((s) => s.ok)).toBe(true);
    expect(gate.active).toBe(3);
    expect(gate.tryEnter(4, 3)).toEqual({ ok: false, reason: "server_busy" });
    const first = slots[0]!;
    if (first.ok) first.release();
    expect(gate.tryEnter(4, 3).ok).toBe(true);
  });

  it("checks the user before the process cap, and release is idempotent", () => {
    const gate = new AskGate();
    const a = gate.tryEnter(1, 1);
    expect(gate.tryEnter(1, 1)).toEqual({ ok: false, reason: "user_busy" });
    expect(gate.tryEnter(2, 1)).toEqual({ ok: false, reason: "server_busy" });
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(gate.active).toBe(0);
    const b = gate.tryEnter(2, 1);
    expect(b.ok).toBe(true);
    // A stale release of the first slot must not free the second user's slot.
    if (a.ok) a.release();
    expect(gate.tryEnter(3, 1)).toEqual({ ok: false, reason: "server_busy" });
  });
});

describe("estimateTokens", () => {
  it("is four characters to a token, rounded up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(8)).toBe(2);
    expect(estimateTokens(9)).toBe(3);
    expect(estimateTokens(-5)).toBe(0);
  });
});

describeDb("anonymous questions in the database", () => {
  let t: TestDatabase;
  const limits = { questionsPerDay: 5, questionsPerTenMinutes: 2 };
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("records an accepted question at once as a count, then refuses past the shared cap", async () => {
    const first = await claimAnonymousQuestion(t.db, "openai-compatible", limits);
    expect(first.ok).toBe(true);
    const second = await claimAnonymousQuestion(t.db, "openai-compatible", limits);
    expect(second.ok).toBe(true);
    const third = await claimAnonymousQuestion(t.db, "openai-compatible", limits);
    expect(third).toMatchObject({ ok: false, reason: "ten_minutes" });
    if (!third.ok) expect(third.retryAfterSeconds).toBeGreaterThan(0);
    const rows = await t.db.select().from(askUsage);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.anonymous && r.userId === null && r.outcome === "started")).toBe(
      true,
    );
  });

  it("does not count another user's rows, and users do not count its rows", async () => {
    await t.db.delete(askUsage);
    const [user] = await t.db
      .insert(users)
      .values({ email: "u@example.com", passwordHash: "x" })
      .returning({ id: users.id });
    await startUsage(t.db, { userId: user!.id, provider: "p", excerptCount: 1 });
    await startUsage(t.db, { userId: user!.id, provider: "p", excerptCount: 1 });
    expect((await claimAnonymousQuestion(t.db, "p", limits)).ok).toBe(true);
    expect(await checkWindows(t.db, user!.id, limits)).toMatchObject({ ok: false });
    expect(await checkWindows(t.db, "anonymous", limits)).toEqual({ ok: true });
  });
});

describeDb("ask usage and limits in the database", () => {
  let t: TestDatabase;
  let userA: number;
  let userB: number;
  const limits = { questionsPerDay: 5, questionsPerTenMinutes: 2 };

  beforeAll(async () => {
    t = await createTestDatabase();
    const rows = await t.db
      .insert(users)
      .values([
        { email: "a@example.com", passwordHash: "x" },
        { email: "b@example.com", passwordHash: "x" },
      ])
      .returning({ id: users.id });
    userA = rows[0]!.id;
    userB = rows[1]!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const clear = () => t.db.delete(askUsage);
  /** Inserts a usage row `secondsAgo` seconds in the past. */
  const addAgo = (userId: number, secondsAgo: number) =>
    t.db.execute(
      sql`insert into ask_usage (user_id, provider, created_at)
          values (${userId}, 'anthropic', now() - make_interval(secs => ${secondsAgo}))`,
    );

  it("allows a user with no questions", async () => {
    await clear();
    expect(await checkWindows(t.db, userA, limits)).toEqual({ ok: true });
  });

  it("refuses at the ten-minute limit with the wait until the oldest question leaves the window", async () => {
    await clear();
    await addAgo(userA, 500);
    expect((await checkWindows(t.db, userA, limits)).ok).toBe(true);
    await addAgo(userA, 100);
    const decision = await checkWindows(t.db, userA, limits);
    expect(decision).toMatchObject({ ok: false, reason: "ten_minutes" });
    if (!decision.ok) {
      // The older question (500 s ago) leaves a 600 s window in about 100 s.
      expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(99);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(101);
    }
  });

  it("does not count questions outside the window, or another user's", async () => {
    await clear();
    await addAgo(userA, TEN_MINUTES_SECONDS + 5);
    await addAgo(userA, TEN_MINUTES_SECONDS + 50);
    await addAgo(userB, 10);
    await addAgo(userB, 20);
    expect(await checkWindows(t.db, userA, limits)).toEqual({ ok: true });
    expect((await checkWindows(t.db, userB, limits)).ok).toBe(false);
  });

  it("refuses at the daily limit and reports the daily wait", async () => {
    await clear();
    for (const ago of [3600, 7200, 10_800, 14_400, 18_000]) await addAgo(userA, ago);
    const decision = await checkWindows(t.db, userA, limits);
    expect(decision).toMatchObject({ ok: false, reason: "daily" });
    if (!decision.ok) {
      // The oldest of the five (5 h ago) leaves the 24 h window in 19 h.
      expect(decision.retryAfterSeconds).toBeGreaterThan(19 * 3600 - 5);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(19 * 3600 + 5);
    }
  });

  it("ignores questions older than a day", async () => {
    await clear();
    for (let i = 0; i < 6; i += 1) await addAgo(userA, DAY_SECONDS + 100 + i);
    expect(await checkWindows(t.db, userA, limits)).toEqual({ ok: true });
  });

  it("records a started question and closes it with tokens and an outcome", async () => {
    await clear();
    const id = await startUsage(t.db, {
      userId: userA,
      provider: "anthropic",
      excerptCount: 3,
      queryTokens: { inputTokens: 100, outputTokens: 10 },
    });
    let [row] = await t.db.select().from(askUsage).where(eq(askUsage.id, id));
    expect(row).toMatchObject({ outcome: "started", excerptCount: 3, inputTokens: 100 });

    await finishUsage(t.db, id, {
      outcome: "ok",
      tokens: { inputTokens: 900, outputTokens: 250 },
      estimated: false,
    });
    [row] = await t.db.select().from(askUsage).where(eq(askUsage.id, id));
    expect(row).toMatchObject({ outcome: "ok", inputTokens: 1000, outputTokens: 260 });

    const id2 = await startUsage(t.db, {
      userId: userA,
      provider: "openai-compatible",
      excerptCount: 1,
    });
    await finishUsage(t.db, id2, {
      outcome: "error_timeout",
      tokens: { inputTokens: 4, outputTokens: 0 },
      estimated: true,
    });
    const [row2] = await t.db.select().from(askUsage).where(eq(askUsage.id, id2));
    expect(row2?.outcome).toBe("error_timeout_estimated");
  });

  it("keeps a row for a user who is later removed, without the user", async () => {
    await clear();
    const [u] = await t.db
      .insert(users)
      .values({ email: "gone@example.com", passwordHash: "x" })
      .returning({ id: users.id });
    const id = await startUsage(t.db, { userId: u!.id, provider: "anthropic", excerptCount: 1 });
    await t.db.delete(users).where(eq(users.id, u!.id));
    const [row] = await t.db.select().from(askUsage).where(eq(askUsage.id, id));
    expect(row?.userId).toBeNull();
  });

  it("removes rows older than 90 days on insert, and only those", async () => {
    await clear();
    await addAgo(userA, 91 * DAY_SECONDS);
    await addAgo(userB, 100 * DAY_SECONDS);
    await addAgo(userA, 89 * DAY_SECONDS);
    await addAgo(userA, 60);
    expect(await t.db.select().from(askUsage)).toHaveLength(4);
    await startUsage(t.db, { userId: userA, provider: "anthropic", excerptCount: 1 });
    const left = await t.db.select().from(askUsage);
    expect(left).toHaveLength(3); // the two old rows are gone, the new one is added
    const ages = await t.db.execute<{ days: number }>(
      sql`select extract(day from now() - created_at)::int as days from ask_usage order by created_at`,
    );
    expect(ages.rows.every((r) => r.days < 90)).toBe(true);
  });

  it("stores no text: the table has no column that could hold content", async () => {
    const cols = await t.db.execute<{ column_name: string; data_type: string }>(
      sql`select column_name, data_type from information_schema.columns where table_name = 'ask_usage'`,
    );
    const text = cols.rows
      .filter((c) => c.data_type === "text")
      .map((c) => c.column_name)
      .sort();
    expect(text).toEqual(["outcome", "provider"]);
  });
});
