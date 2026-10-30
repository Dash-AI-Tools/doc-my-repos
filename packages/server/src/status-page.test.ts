import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/errors";
import type { Db } from "./db/client";
import { repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { loadStatusPage } from "./status-page";

const NOW = new Date("2026-10-10T12:00:00Z");

function failingDb(error: unknown): Db {
  return {
    execute() {
      throw error;
    },
    select() {
      throw error;
    },
  } as unknown as Db;
}

describe("loadStatusPage", () => {
  it("turns an unreachable database into the error state and logs only the kind", async () => {
    const log = vi.fn();
    const error = Object.assign(new Error("connect postgres://u:sentinel@h/db"), {
      code: "ECONNREFUSED",
    });
    const data = await loadStatusPage({ db: () => failingDb(error), now: () => NOW, log });
    expect(data).toEqual({ status: "error", loadedAt: NOW });
    expect(log).toHaveBeenCalledWith("status_page.load_failed", {
      reason: "database error (ECONNREFUSED)",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sentinel");
  });

  it("turns a configuration error into the error state", async () => {
    const log = vi.fn();
    const data = await loadStatusPage({
      db: () => {
        throw new ConfigError(["SYNC_SECRET: missing"]);
      },
      now: () => NOW,
      log,
    });
    expect(data.status).toBe("error");
    expect(log).toHaveBeenCalledWith("status_page.load_failed", { reason: "ConfigError" });
  });

  it("lets an unexpected error propagate", async () => {
    await expect(
      loadStatusPage({ db: () => failingDb(new Error("bug")), log: () => undefined }),
    ).rejects.toThrow("bug");
  });
});

describeDb("loadStatusPage public access", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const load = (
    over: Parameters<typeof loadStatusPage>[0] extends infer D ? Partial<D> : never = {},
  ) =>
    loadStatusPage({
      db: () => Promise.resolve(t.db),
      now: () => NOW,
      askState: async () => ({ state: "off" }),
      workspaceState: async () => {
        throw new Error("not needed");
      },
      ...over,
    });

  it("reports nothing public with the default switches, then something public", async () => {
    const before = await load();
    if (before.status !== "ok") throw new Error("expected ok");
    expect(before.publicAccess).toEqual({
      anyPublic: false,
      searchEnabled: true,
      askEnabled: false,
    });
    await t.db.insert(repos).values({
      githubId: 1,
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
      visibility: "private",
      htmlUrl: "https://github.com/acme/docs",
      isPublic: true,
    });
    const after = await load();
    if (after.status !== "ok") throw new Error("expected ok");
    expect(after.publicAccess?.anyPublic).toBe(true);
  });

  it("leaves the section out when public access cannot be read", async () => {
    const data = await load({ publicAccessState: () => Promise.reject(new Error("boom")) });
    if (data.status !== "ok") throw new Error("expected ok");
    expect(data.publicAccess).toBeNull();
  });
});
