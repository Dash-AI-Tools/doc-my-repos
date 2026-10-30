import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { repoFolders, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { NOTHING_PUBLIC, getPublicAccessState } from "./state";

describeDb("public access state", () => {
  let t: TestDatabase;
  let repoId = 0;
  beforeAll(async () => {
    t = await createTestDatabase();
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId: 1,
        owner: "acme",
        name: "handbook",
        defaultBranch: "main",
        visibility: "private",
        htmlUrl: "https://github.com/acme/handbook",
      })
      .returning({ id: repos.id });
    repoId = row!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.update(repos).set({ isPublic: false, isAllowed: true, folderId: null });
    await t.db.delete(repoFolders);
  });

  const db = () => Promise.resolve(t.db);

  it("reports nothing public when nothing is marked", async () => {
    const state = await getPublicAccessState(db);
    expect(state.anyPublic).toBe(false);
    expect(state.settings.searchEnabled).toBe(true);
  });

  it("sees a public repository, a public folder's repository, and not a blocked one", async () => {
    await t.db.update(repos).set({ isPublic: true }).where(eq(repos.id, repoId));
    expect((await getPublicAccessState(db)).anyPublic).toBe(true);

    await t.db.update(repos).set({ isAllowed: false }).where(eq(repos.id, repoId));
    expect((await getPublicAccessState(db)).anyPublic).toBe(false);

    const [folder] = await t.db
      .insert(repoFolders)
      .values({ name: "Open", isPublic: true })
      .returning({ id: repoFolders.id });
    await t.db
      .update(repos)
      .set({ isPublic: false, isAllowed: true, folderId: folder!.id })
      .where(eq(repos.id, repoId));
    expect((await getPublicAccessState(db)).anyPublic).toBe(true);
  });

  it("follows a change on the very next read: nothing is kept between calls", async () => {
    expect((await getPublicAccessState(db)).anyPublic).toBe(false);
    await t.db.update(repos).set({ isPublic: true }).where(eq(repos.id, repoId));
    expect((await getPublicAccessState(db)).anyPublic).toBe(true);
    await t.db.update(repos).set({ isPublic: false }).where(eq(repos.id, repoId));
    expect((await getPublicAccessState(db)).anyPublic).toBe(false);
  });

  it("fails closed on a database error and does not throw", async () => {
    const broken = () => Promise.reject(new Error("connection refused"));
    expect(await getPublicAccessState(broken)).toBe(NOTHING_PUBLIC);
    await t.db.update(repos).set({ isPublic: true }).where(eq(repos.id, repoId));
    expect((await getPublicAccessState(db)).anyPublic).toBe(true);
  });
});
