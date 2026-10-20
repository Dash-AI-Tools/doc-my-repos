import { afterAll, beforeAll, expect, it } from "vitest";

import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { repoFolders } from "../db/schema";
import { listFolders } from "./folders";

describeDb("listFolders", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("is empty when no folder exists", async () => {
    expect(await listFolders(t.db)).toEqual([]);
  });

  it("lists starred folders first by place then the rest by name, with description and id", async () => {
    await t.db
      .insert(repoFolders)
      .values([
        { name: "beta", description: "Second" },
        { name: "Alpha" },
        { name: "Zed", starPosition: 0 },
        { name: "Mid", starPosition: 1, description: "<b>text</b>" },
      ]);
    const list = await listFolders(t.db);
    expect(list.map((f) => f.name)).toEqual(["Zed", "Mid", "Alpha", "beta"]);
    expect(list.map((f) => f.isStarred)).toEqual([true, true, false, false]);
    expect(list[1]).toMatchObject({ description: "<b>text</b>", starPosition: 1 });
    expect(list[2]?.description).toBeNull();
    expect(typeof list[0]?.id).toBe("number");
  });
});
