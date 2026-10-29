import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { DEFAULT_TENANT } from "@docmyrepos/core";

import { publicAccessSettings, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { ANONYMOUS, MEMBER } from "../queries/visibility";
import { anonymousMayUse, readerOf } from "./reader";

describeDb("readers and what an anonymous visitor may do", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.delete(repos);
    await t.db.delete(publicAccessSettings);
  });

  const ctx = (db: () => Promise<typeof t.db> = () => Promise.resolve(t.db)) => ({
    tenant: DEFAULT_TENANT,
    db,
  });
  const addPublicRepo = () =>
    t.db.insert(repos).values({
      githubId: 1,
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
      visibility: "public",
      htmlUrl: "https://github.com/acme/docs",
      isPublic: true,
    });

  it("tells a signed-in user from an anonymous visitor", async () => {
    expect(await readerOf({ user: async () => ({ id: 1, email: "a@x", role: "user" }) })).toBe(
      MEMBER,
    );
    expect(await readerOf({ user: async () => null })).toBe(ANONYMOUS);
  });

  it("allows nothing while nothing is public, whatever the switches say", async () => {
    await t.db
      .insert(publicAccessSettings)
      .values({ id: 1, searchEnabled: true, askEnabled: true });
    for (const need of ["content", "search", "ask"] as const) {
      expect(await anonymousMayUse(ctx(), need), need).toBe(false);
    }
  });

  it("allows reading once something is public, and search on by default but Ask off", async () => {
    await addPublicRepo();
    expect(await anonymousMayUse(ctx(), "content")).toBe(true);
    expect(await anonymousMayUse(ctx(), "search")).toBe(true);
    expect(await anonymousMayUse(ctx(), "ask")).toBe(false);
  });

  it("follows the admin's switches for search and Ask", async () => {
    await addPublicRepo();
    await t.db
      .insert(publicAccessSettings)
      .values({ id: 1, searchEnabled: false, askEnabled: true });
    expect(await anonymousMayUse(ctx(), "content")).toBe(true);
    expect(await anonymousMayUse(ctx(), "search")).toBe(false);
    expect(await anonymousMayUse(ctx(), "ask")).toBe(true);
  });

  it("answers no, without throwing, when the database cannot be read", async () => {
    const broken = () => Promise.reject(new Error("connection refused"));
    for (const need of ["content", "search", "ask"] as const) {
      expect(await anonymousMayUse(ctx(broken as never), need), need).toBe(false);
    }
  });
});
