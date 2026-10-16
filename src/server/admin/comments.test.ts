import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "../db/client";
import { docComments, documents, repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";

vi.mock("server-only", () => ({}));

import { loadModeration, parseModerationFilters } from "./comments";

describe("parseModerationFilters", () => {
  it("accepts known values and ignores malformed ones", () => {
    expect(parseModerationFilters({ state: "orphaned", repo: "42" })).toEqual({
      state: "orphaned",
      githubRepoId: 42,
      cursor: null,
    });
    expect(parseModerationFilters({ state: "Orphaned", repo: "0x1", cursor: "nope" })).toEqual({
      state: null,
      githubRepoId: null,
      cursor: null,
    });
    expect(parseModerationFilters({ state: ["live", "deleted"] }).state).toBe("live");
  });
});

describe("loadModeration refuses non-admins", () => {
  it("does not read when the admin check throws", async () => {
    const db = {} as Db;
    await expect(
      loadModeration(
        {},
        {
          db: () => db,
          admin: async () => {
            throw new Error("403");
          },
        },
      ),
    ).rejects.toThrow("403");
  });

  it("reports unavailable when the read fails", async () => {
    const data = await loadModeration(
      {},
      { db: () => ({}) as Db, admin: async () => undefined, enabled: () => true },
    );
    expect(data).toEqual({ status: "unavailable" });
  });
});

describeDb("loadModeration on a real database", () => {
  let t: TestDatabase;
  let db: Db;
  const NOW = new Date("2026-10-10T12:00:00Z");
  const deps = (enabled = true) => ({
    db: () => db,
    admin: async () => undefined,
    enabled: () => enabled,
    now: () => NOW,
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    const make = async (githubId: number, name: string, isAllowed: boolean) => {
      const [repo] = await db
        .insert(repos)
        .values({
          githubId,
          owner: "acme",
          name,
          defaultBranch: "main",
          visibility: "public",
          htmlUrl: `https://github.com/acme/${name}`,
          isAllowed,
          docsPath: "docs",
        })
        .returning({ id: repos.id });
      await db.insert(documents).values({
        repoId: repo!.id,
        path: "docs/a.md",
        title: "A",
        blobSha: "x",
        sizeBytes: 1,
        body: "x",
      });
    };
    await make(1, "api", true);
    await make(2, "hidden", false);
    const [ana] = await db
      .insert(users)
      .values({ email: "ana@example.com", passwordHash: "x", role: "user" })
      .returning({ id: users.id });
    const base = { authorId: ana!.id, authorLabel: "ana" };
    let minute = 0;
    const add = (over: Partial<typeof docComments.$inferInsert>) =>
      db.insert(docComments).values({
        ...base,
        githubRepoId: 1,
        path: "docs/a.md",
        body: "hello",
        createdAt: new Date(NOW.getTime() - ++minute * 60_000),
        ...over,
      });
    await add({ body: `live ${"x".repeat(400)}` });
    await add({ githubRepoId: 2, body: "in a blocked repo" });
    await add({ githubRepoId: 3, path: "docs/gone.md", body: "orphan one" });
    await add({ githubRepoId: 3, path: "docs/gone.md", body: "orphan two", authorId: null });
    await add({ githubRepoId: 1, path: "docs/removed.md", body: "doc removed" });
    await add({ body: "secret", deletedAt: NOW, deletedByAdmin: true });
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("lists every state newest first with excerpts, links and group counts", async () => {
    const data = await loadModeration({}, deps());
    if (data.status !== "ready") throw new Error(data.status);
    expect(data.enabled).toBe(true);
    const byState = (s: string) => data.rows.filter((r) => r.state === s);
    expect(byState("live")).toHaveLength(1);
    expect(byState("blocked")).toHaveLength(1);
    expect(byState("deleted")).toHaveLength(1);
    expect(byState("orphaned")).toHaveLength(3);
    const live = byState("live")[0]!;
    expect(Array.from(live.excerpt)).toHaveLength(201);
    expect(live.docHref).toBe("/acme/api/docs/a");
    expect(live.authorEmail).toBe("ana@example.com");
    expect(byState("deleted")[0]!.excerpt).toBe("");
    expect(byState("blocked")[0]!.repoLabel).toBe("acme/hidden");
    const gone = byState("orphaned").find((r) => r.githubRepoId === 3)!;
    expect(gone.repoLabel).toBeNull();
    expect(gone.docHref).toBeNull();
    expect(gone.groupCount).toBe(2);
    expect(byState("orphaned").find((r) => r.path === "docs/removed.md")!.groupCount).toBe(1);
    const times = data.rows.map((r) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("filters by state and repository and pages with a cursor", async () => {
    const orphaned = await loadModeration({ state: "orphaned" }, deps());
    if (orphaned.status !== "ready") throw new Error();
    expect(orphaned.rows.map((r) => r.state)).toEqual(["orphaned", "orphaned", "orphaned"]);
    const blocked = await loadModeration({ state: "blocked" }, deps());
    if (blocked.status !== "ready") throw new Error();
    expect(blocked.rows).toHaveLength(1);
    const repo3 = await loadModeration({ repo: "3" }, deps());
    if (repo3.status !== "ready") throw new Error();
    expect(repo3.rows).toHaveLength(2);
    const nothing = await loadModeration({ repo: "999" }, deps());
    if (nothing.status !== "ready") throw new Error();
    expect(nothing.rows).toEqual([]);
  });

  it("reports comments as off but still lists them", async () => {
    const data = await loadModeration({}, deps(false));
    if (data.status !== "ready") throw new Error();
    expect(data.enabled).toBe(false);
    expect(data.rows.length).toBe(6);
  });
});
