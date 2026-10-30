import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/errors";
import { createDb, type Db } from "./db/client";
import { repoFolders, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { expectedFailureKind, groupHome, loadHome } from "./home";
import type { FolderSummary, RepoSummary } from "./queries";

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
      folders: [],
      repos: [],
      tabs: [],
      folder: null,
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

  describe("folders", () => {
    const folderIds: Record<string, number> = {};
    const place = async (githubId: number, folder: string | null, set: object = {}) =>
      t.db
        .update(repos)
        .set({ folderId: folder === null ? null : folderIds[folder], ...set })
        .where(eq(repos.githubId, githubId));

    it("with no folder keeps exactly the previous sections (nothing starred or in folders)", async () => {
      await t.db.update(repos).set({ starPosition: null });
      const data = await loadHome({ db: () => t.db, now: () => NOW });
      if (data.status !== "ok") throw new Error("expected ok");
      expect(data).toMatchObject({ starred: [], folders: [], tabs: [], folder: null });
      expect(data.repos.map((r) => r.name)).toEqual(["alpha", "mid", "plain", "tie", "zeta"]);
    });

    it("groups by folder name, drops empty, blocked-only and starred-only folders, and tabs follow the star order", async () => {
      const rows = await t.db
        .insert(repoFolders)
        .values([
          { name: "beta", description: "B <b>desc</b>", starPosition: 1 },
          { name: "Alpha", starPosition: 0 },
          { name: "Empty" },
          { name: "BlockedOnly", starPosition: 2 },
          { name: "StarredOnly" },
        ])
        .returning();
      for (const r of rows) folderIds[r.name] = r.id;
      // alpha(1) mid(3) -> beta; plain(6) -> Alpha; hidden(5, blocked) -> BlockedOnly; tie(4) starred -> StarredOnly
      await place(1, "beta");
      await place(3, "beta");
      await place(6, "Alpha");
      await place(5, "BlockedOnly");
      await place(4, "StarredOnly", { starPosition: 5 });
      await t.db.update(repos).set({ starPosition: null }).where(eq(repos.githubId, 1));
      await t.db.update(repos).set({ starPosition: null }).where(eq(repos.githubId, 3));

      const data = await loadHome({ db: () => t.db, now: () => NOW });
      if (data.status !== "ok") throw new Error("expected ok");
      expect(data.starred.map((r) => r.name)).toEqual(["tie"]);
      expect(data.folders.map((f) => f.name)).toEqual(["Alpha", "beta"]);
      expect(data.folders[1]).toMatchObject({ description: "B <b>desc</b>" });
      expect(data.folders[1]?.repos.map((r) => r.name)).toEqual(["alpha", "mid"]);
      expect(data.repos.map((r) => r.name)).toEqual(["zeta"]);
      // Tabs: starred folders with a visible repo, in star order (BlockedOnly has none visible).
      expect(data.tabs.map((x) => x.name)).toEqual(["Alpha", "beta"]);
      expect(data.folder).toBeNull();
    });

    it("selects a folder tab with all its visible repos (starred included); bad ids fall back to All", async () => {
      await place(4, "beta"); // starred repo joins beta
      const pick = async (id?: number) => {
        const d = await loadHome({ db: () => t.db, now: () => NOW }, id);
        if (d.status !== "ok") throw new Error("expected ok");
        return d;
      };
      const d = await pick(folderIds.beta);
      expect(d.folder?.name).toBe("beta");
      expect(d.folder?.repos.map((r) => r.name)).toEqual(["alpha", "mid", "tie"]);
      // Starred repo is under Starred only in the All data.
      expect(d.starred.map((r) => r.name)).toEqual(["tie"]);
      expect(d.folders.find((f) => f.name === "beta")?.repos.map((r) => r.name)).toEqual([
        "alpha",
        "mid",
      ]);
      expect((await pick(folderIds.StarredOnly)).folder).toBeNull(); // not starred, no tab
      expect((await pick(folderIds.BlockedOnly)).folder).toBeNull(); // no visible repo
      expect((await pick(folderIds.Empty)).folder).toBeNull();
      expect((await pick(999999)).folder).toBeNull();
      expect((await pick(undefined)).folder).toBeNull();
    });

    it("blocking hides the folder, allowing returns it in the same folder", async () => {
      await t.db
        .update(repos)
        .set({ isAllowed: false })
        .where(eq(repos.folderId, folderIds.Alpha!));
      let d = await loadHome({ db: () => t.db, now: () => NOW });
      if (d.status !== "ok") throw new Error("expected ok");
      expect(d.tabs.map((x) => x.name)).toEqual(["beta"]);
      expect(d.folders.map((f) => f.name)).toEqual(["beta"]);
      await t.db.update(repos).set({ isAllowed: true }).where(eq(repos.folderId, folderIds.Alpha!));
      d = await loadHome({ db: () => t.db, now: () => NOW });
      if (d.status !== "ok") throw new Error("expected ok");
      expect(d.folders.map((f) => f.name)).toEqual(["Alpha", "beta"]);
    });
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

describe("groupHome", () => {
  const summary = (id: number, folderId: number | null, starPosition: number | null = null) =>
    ({
      id,
      owner: "o",
      name: `r${id}`,
      folderId,
      starPosition,
      isStarred: starPosition !== null,
    }) as RepoSummary;
  const folder = (id: number, name: string, starPosition: number | null = null) =>
    ({
      id,
      name,
      description: null,
      starPosition,
      isStarred: starPosition !== null,
    }) as FolderSummary;

  it("is the plain two-list split when there are no folders", () => {
    const out = groupHome([summary(1, null), summary(2, null, 0)], []);
    expect(out.starred.map((r) => r.id)).toEqual([2]);
    expect(out.repos.map((r) => r.id)).toEqual([1]);
    expect(out).toMatchObject({ folders: [], tabs: [], folder: null });
  });

  it("orders sections by name ignoring case, whatever the star order of the folders", () => {
    const out = groupHome(
      [summary(1, 10), summary(2, 20), summary(3, 30)],
      [folder(10, "zeta", 0), folder(20, "Alpha"), folder(30, "beta")],
    );
    expect(out.folders.map((f) => f.name)).toEqual(["Alpha", "beta", "zeta"]);
    expect(out.tabs).toEqual([{ id: 10, name: "zeta" }]);
  });
});

describeDb("loadHome for a visitor without a session (public access)", () => {
  let t: TestDatabase;
  const reader = { kind: "anonymous" } as const;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const add = async (
    githubId: number,
    name: string,
    over: Partial<typeof repos.$inferInsert> = {},
  ) => {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner: "acme",
        name,
        defaultBranch: "main",
        visibility: "private",
        htmlUrl: `https://github.com/acme/${name}`,
        ...over,
      })
      .returning({ id: repos.id });
    return row!.id;
  };
  const home = async () => {
    const data = await loadHome({ db: () => t.db, now: () => NOW, reader });
    if (data.status !== "ok") throw new Error("expected ok");
    return data;
  };

  it("lists nothing while nothing is public, and a signed-in user still sees everything", async () => {
    await add(1, "plain");
    const data = await home();
    expect([data.starred, data.folders, data.repos, data.tabs]).toEqual([[], [], [], []]);
    const member = await loadHome({ db: () => t.db, now: () => NOW });
    if (member.status !== "ok") throw new Error("expected ok");
    expect(member.repos.map((r) => r.name)).toEqual(["plain"]);
  });

  it("lists a public repository, in the admin's starred order, and no other", async () => {
    await add(2, "open", { isPublic: true, starPosition: 0 });
    const data = await home();
    expect(data.starred.map((r) => r.name)).toEqual(["open"]);
    expect(data.repos).toEqual([]);
  });

  it("shows a public folder with all of its repositories", async () => {
    const [folder] = await t.db
      .insert(repoFolders)
      .values({ name: "Open source", description: "Public things", isPublic: true })
      .returning();
    await add(3, "oss-a", { folderId: folder!.id });
    await add(4, "oss-b", { folderId: folder!.id });
    const data = await home();
    expect(data.folders.map((f) => [f.name, f.repos.map((r) => r.name)])).toEqual([
      ["Open source", ["oss-a", "oss-b"]],
    ]);
  });

  it("lists a public repository of a non-public folder without revealing the folder", async () => {
    const [folder] = await t.db
      .insert(repoFolders)
      .values({ name: "Internal secrets", description: "Do not show", starPosition: 0 })
      .returning();
    await add(5, "leaky", { isPublic: true, folderId: folder!.id });
    await add(6, "hidden-sibling", { folderId: folder!.id });
    const data = await home();
    expect(data.repos.map((r) => r.name)).toContain("leaky");
    expect(data.repos.every((r) => r.folderId === null)).toBe(true);
    expect(data.folders.map((f) => f.name)).not.toContain("Internal secrets");
    expect(data.tabs).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("Internal secrets");
    expect(JSON.stringify(data)).not.toContain("Do not show");
    expect(JSON.stringify(data)).not.toContain("hidden-sibling");
  });

  it("hides a blocked repository even when it is public", async () => {
    await add(7, "blocked-public", { isPublic: true, isAllowed: false });
    const data = await home();
    const names = [...data.starred, ...data.repos, ...data.folders.flatMap((f) => f.repos)].map(
      (r) => r.name,
    );
    expect(names).not.toContain("blocked-public");
  });

  it("shows the tab of a starred public folder", async () => {
    const [folder] = await t.db
      .insert(repoFolders)
      .values({ name: "Docs tab", isPublic: true, starPosition: 1 })
      .returning();
    await add(8, "in-tab", { folderId: folder!.id });
    const data = await home();
    expect(data.tabs.map((tab) => tab.name)).toContain("Docs tab");
  });
});
