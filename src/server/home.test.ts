import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/errors";
import { createDb, type Db } from "./db/client";
import { repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { expectedFailureKind, loadHome } from "./home";

const NOW = new Date("2026-10-10T12:00:00Z");

/** A Db whose first query throws `error`, as a dead connection would. */
function failingDb(error: unknown): Db {
  return {
    select() {
      throw error;
    },
  } as unknown as Db;
}

function osError(code: string): Error {
  return Object.assign(new Error("connect failed to postgres://user:secret@10.1.2.3:5432/db"), {
    code,
  });
}

describe("expectedFailureKind", () => {
  it("accepts a config problem, a SQLSTATE, an OS code and a connect timeout", () => {
    expect(expectedFailureKind(new ConfigError(["DATABASE_URL: is not set"]))).toBe("ConfigError");
    expect(expectedFailureKind(osError("ECONNREFUSED"))).toBe("database error (ECONNREFUSED)");
    expect(expectedFailureKind(Object.assign(new Error("x"), { code: "3D000" }))).toBe(
      "database error (3D000)",
    );
    expect(expectedFailureKind(new Error("timeout exceeded when trying to connect"))).toBe(
      "database error (timeout)",
    );
  });

  it("looks through a wrapper to the driver error", () => {
    const wrapped = new Error("Failed query", { cause: osError("ENOTFOUND") });
    expect(expectedFailureKind(wrapped)).toBe("database error (ENOTFOUND)");
  });

  it("rejects anything else as unexpected", () => {
    expect(expectedFailureKind(new TypeError("x is not a function"))).toBeNull();
    expect(expectedFailureKind("boom")).toBeNull();
    expect(expectedFailureKind(undefined)).toBeNull();
  });
});

describe("loadHome failures", () => {
  it("returns the error state and logs only a fixed message with the kind", async () => {
    const log = vi.fn();
    const data = await loadHome({
      db: () => failingDb(osError("ECONNREFUSED")),
      now: () => NOW,
      log,
    });
    expect(data).toEqual({ status: "error", loadedAt: NOW });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("home.load_failed", {
      reason: "database error (ECONNREFUSED)",
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toMatch(/secret|10\.1\.2\.3|postgres:/);
  });

  it("returns the error state when the runtime cannot be built", async () => {
    const log = vi.fn();
    const data = await loadHome({
      db: () => {
        throw new ConfigError(["SYNC_SECRET: is not set"]);
      },
      now: () => NOW,
      log,
    });
    expect(data.status).toBe("error");
    expect(log).toHaveBeenCalledWith("home.load_failed", { reason: "ConfigError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNC_SECRET");
  });

  it("rethrows an unexpected error for the error boundary, without logging it", async () => {
    const log = vi.fn();
    const bug = new TypeError("x is not a function");
    await expect(loadHome({ db: () => failingDb(bug), log })).rejects.toBe(bug);
    expect(log).not.toHaveBeenCalled();
  });
});

describeDb("loadHome on a real database", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  it("returns ok with an empty list for an empty database", async () => {
    expect(await loadHome({ db: () => t.db, now: () => NOW })).toEqual({
      status: "ok",
      starred: [],
      repos: [],
      loadedAt: NOW,
    });
  });

  it("lists public and private repositories, ordered by owner and name", async () => {
    await t.db.insert(repos).values([
      {
        githubId: 2,
        owner: "acme",
        name: "zeta",
        defaultBranch: "main",
        visibility: "private",
        htmlUrl: "https://github.com/acme/zeta",
      },
      {
        githubId: 1,
        owner: "acme",
        name: "alpha",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/alpha",
      },
    ]);
    const data = await loadHome({ db: () => t.db, now: () => NOW });
    expect(data.status).toBe("ok");
    if (data.status !== "ok") return;
    expect(data.repos.map((r) => `${r.owner}/${r.name}:${r.visibility}`)).toEqual([
      "acme/alpha:public",
      "acme/zeta:private",
    ]);
    expect(data.repos[0]?.syncStatus).toBe("pending");
  });

  it("puts starred repositories first in the admin order and keeps the rest alphabetical", async () => {
    await t.db.update(repos).set({ starPosition: 1 }).where(eq(repos.githubId, 1)); // acme/alpha
    await t.db.insert(repos).values(
      [
        { githubId: 3, owner: "acme", name: "mid", starPosition: 0 },
        { githubId: 4, owner: "acme", name: "tie", starPosition: 1 },
        { githubId: 5, owner: "acme", name: "hidden", starPosition: 2, isAllowed: false },
        { githubId: 6, owner: "acme", name: "plain" },
      ].map((r) => ({
        defaultBranch: "main",
        visibility: "public" as const,
        htmlUrl: `https://github.com/${r.owner}/${r.name}`,
        ...r,
      })),
    );
    const data = await loadHome({ db: () => t.db, now: () => NOW });
    if (data.status !== "ok") throw new Error("expected ok");
    // Order differs from alphabetical (mid before alpha); equal places fall back to id;
    // the blocked starred repo is absent from both sections.
    expect(data.starred.map((r) => r.name)).toEqual(["mid", "alpha", "tie"]);
    expect(data.repos.map((r) => r.name)).toEqual(["plain", "zeta"]);
  });

  it("returns everything as starred, and an empty rest, when every repository is starred", async () => {
    await t.db.update(repos).set({ starPosition: 9 }).where(isNull(repos.starPosition));
    const data = await loadHome({ db: () => t.db, now: () => NOW });
    if (data.status !== "ok") throw new Error("expected ok");
    expect(data.repos).toEqual([]);
    expect(data.starred).toHaveLength(5);
  });

  it("reports an unreachable database as the error state", async () => {
    const dead = createDb("postgres://u:p@127.0.0.1:1/none", { connectTimeoutMs: 2_000 });
    try {
      const log = vi.fn();
      const data = await loadHome({ db: () => dead.db, now: () => NOW, log });
      expect(data.status).toBe("error");
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).toBe("home.load_failed");
      expect(String(log.mock.calls[0]?.[1]?.reason)).toMatch(
        /database error \((ECONNREFUSED|timeout)\)$/,
      );
    } finally {
      await dead.close();
    }
  });
});
