import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { findAssetRepo } from "./assets";
import {
  activeRepoVisibility,
  allowedReposOnly,
  publicReposOnly,
  type RepoVisibilityFilter,
  visibleRepos,
} from "./visibility";

describe("visibility filter", () => {
  it("hides admin-blocked repositories by default", () => {
    expect(activeRepoVisibility).toBe(allowedReposOnly);
  });

  it("builds the condition from the filter it is given", () => {
    const calls: unknown[] = [];
    const spy: RepoVisibilityFilter = (table) => {
      calls.push(table);
      return sql`false`;
    };
    visibleRepos({ visibility: spy });
    expect(calls).toEqual([repos]);
  });
});

describeDb("findAssetRepo on a real database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(repos).values([
      {
        githubId: 11,
        owner: "Acme",
        name: "Handbook",
        defaultBranch: "main",
        visibility: "private",
        htmlUrl: "https://github.com/Acme/Handbook",
      },
      {
        githubId: 12,
        owner: "acme",
        name: "site",
        defaultBranch: "trunk",
        visibility: "public",
        htmlUrl: "https://github.com/acme/site",
      },
      // Two rows that differ only by case (a moment after a rename).
      {
        githubId: 13,
        owner: "acme",
        name: "Twin",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/Twin",
      },
      {
        githubId: 14,
        owner: "acme",
        name: "twin",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/twin",
      },
    ]);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("finds a repository ignoring case and returns the canonical spelling", async () => {
    const found = await findAssetRepo(t.db, "ACME", "handbook");
    expect(found).toEqual({
      githubId: 11,
      owner: "Acme",
      name: "Handbook",
      defaultBranch: "main",
      visibility: "private",
    });
    expect((await findAssetRepo(t.db, "acme", "SITE"))?.defaultBranch).toBe("trunk");
  });

  it("returns null for an unknown repository", async () => {
    expect(await findAssetRepo(t.db, "acme", "nope")).toBeNull();
    expect(await findAssetRepo(t.db, "other", "site")).toBeNull();
  });

  it("prefers the exact spelling and refuses an ambiguous case-insensitive match", async () => {
    expect((await findAssetRepo(t.db, "acme", "Twin"))?.githubId).toBe(13);
    expect((await findAssetRepo(t.db, "acme", "twin"))?.githubId).toBe(14);
    expect(await findAssetRepo(t.db, "acme", "TWIN")).toBeNull();
  });

  it("treats input as data, not SQL or patterns", async () => {
    expect(await findAssetRepo(t.db, "acme", "%")).toBeNull();
    expect(await findAssetRepo(t.db, "acme", "site' or '1'='1")).toBeNull();
  });

  it("goes through the visibility filter: a restrictive filter hides the repository", async () => {
    expect(
      await findAssetRepo(t.db, "acme", "handbook", { visibility: publicReposOnly }),
    ).toBeNull();
    expect(
      (await findAssetRepo(t.db, "acme", "site", { visibility: publicReposOnly }))?.githubId,
    ).toBe(12);
    const hideAll: RepoVisibilityFilter = () => sql`false`;
    expect(await findAssetRepo(t.db, "acme", "site", { visibility: hideAll })).toBeNull();
  });
});
