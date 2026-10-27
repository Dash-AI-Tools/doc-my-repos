import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./db/client";
import { docComments, documents, repos, users } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { DEFAULT_ORG_NAME, loadDocComments } from "./doc-comments";

const NOW = new Date("2026-10-10T12:00:00Z");

describe("loadDocComments without a database", () => {
  it("is disabled when comments are off, without reading anything", async () => {
    const data = await loadDocComments("acme", "api", "docs/a.md", {
      enabled: () => false,
      db: () => {
        throw new Error("must not be read");
      },
    });
    expect(data).toEqual({ status: "disabled" });
  });

  it("is hidden for nobody signed in and unavailable when the read fails", async () => {
    const db = {} as Db;
    expect(
      await loadDocComments("acme", "api", "docs/a.md", {
        enabled: () => true,
        db: () => db,
        user: async () => null,
      }),
    ).toEqual({ status: "hidden" });
    expect(
      await loadDocComments("acme", "api", "docs/a.md", {
        enabled: () => true,
        db: () => {
          throw new Error("down");
        },
      }),
    ).toEqual({ status: "unavailable" });
  });
});

describeDb("loadDocComments on a real database", () => {
  let t: TestDatabase;
  let db: Db;
  let ana: number;
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    const [repo] = await db
      .insert(repos)
      .values({
        githubId: 77,
        owner: "acme",
        name: "api",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/api",
        isAllowed: true,
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
    const [user] = await db
      .insert(users)
      .values({ email: "ana@example.com", passwordHash: "x", role: "user" })
      .returning({ id: users.id });
    ana = user!.id;
    const [root] = await db
      .insert(docComments)
      .values({
        githubRepoId: 77,
        path: "docs/a.md",
        authorId: ana,
        authorLabel: "ana",
        body: "Hi",
      })
      .returning({ id: docComments.id });
    await db.insert(docComments).values({
      githubRepoId: 77,
      path: "docs/a.md",
      parentId: root!.id,
      authorId: null,
      authorLabel: "gone",
      body: "Reply from a removed account",
    });
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const deps = (role: "admin" | "user", orgName: string | null = null) => ({
    enabled: () => true,
    db: () => db,
    user: async () => ({ id: ana, role }),
    orgName: async () => orgName,
    now: () => NOW,
  });

  it("returns threads, counts and the viewer, with the email only for an admin", async () => {
    const viewer = await loadDocComments("acme", "api", "docs/a.md", deps("user"));
    if (viewer.status !== "ready") throw new Error(viewer.status);
    expect(viewer.counts).toEqual({ comments: 2, openThreads: 1 });
    expect(viewer.threads[0]?.root.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(viewer.threads[0]?.root.authorEmail).toBeNull();
    expect(viewer.threads[0]?.replies[0]?.authorLabel).toBe("gone");
    expect(viewer.viewer).toEqual({ userId: ana, isAdmin: false });
    expect(viewer.orgName).toBe(DEFAULT_ORG_NAME);
    expect(viewer.loadedAt).toBe(NOW.toISOString());

    const admin = await loadDocComments("acme", "api", "docs/a.md", deps("admin", "Acme Inc"));
    if (admin.status !== "ready") throw new Error(admin.status);
    expect(admin.threads[0]?.root.authorEmail).toBe("ana@example.com");
    expect(admin.viewer.isAdmin).toBe(true);
    expect(admin.orgName).toBe("Acme Inc");
  });

  it("returns nothing for a document that does not exist", async () => {
    const data = await loadDocComments("acme", "api", "docs/missing.md", deps("user"));
    if (data.status !== "ready") throw new Error(data.status);
    expect(data.threads).toEqual([]);
    expect(data.counts).toEqual({ comments: 0, openThreads: 0 });
  });
});
