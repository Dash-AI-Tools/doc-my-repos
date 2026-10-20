import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { repoFolders, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { listFolders } from "../queries/folders";
import {
  FOLDER_DESCRIPTION_MAX,
  FOLDER_NAME_MAX,
  createFolder,
  deleteFolder,
  reorderStarredFolders,
  updateFolder,
} from "./folders";
import { updateRepoFlags } from "./repos";

describeDb("admin folders", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.delete(repoFolders);
  });

  const make = async (name: string) => {
    const r = await createFolder(t.db, { name });
    if (!r.ok) throw new Error(r.error);
    return r.folder.id;
  };
  const names = async () => (await listFolders(t.db)).map((f) => f.name);

  it("creates a folder, trimming the name and storing an empty description as null", async () => {
    const r = await createFolder(t.db, { name: "  Payments ", description: "   " });
    expect(r).toMatchObject({
      ok: true,
      folder: { name: "Payments", description: null, starPosition: null, isStarred: false },
    });
    const d = await createFolder(t.db, { name: "Billing", description: " Money things " });
    expect(d).toMatchObject({ ok: true, folder: { description: "Money things" } });
  });

  it("rejects bad input with 400 and a duplicate name (any case) with 409, writing nothing", async () => {
    await make("Payments");
    for (const input of [
      { name: "" },
      { name: "   " },
      { name: 5 },
      { name: "x".repeat(FOLDER_NAME_MAX + 1) },
      { name: "ok", description: "x".repeat(FOLDER_DESCRIPTION_MAX + 1) },
      { name: "ok", description: 7 },
    ]) {
      expect(await createFolder(t.db, input), JSON.stringify(input).slice(0, 40)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(await createFolder(t.db, { name: "PAYMENTS" })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await names()).toEqual(["Payments"]);
  });

  it("edits name and description; keeps own name on rename; 409 on another's name; 404 unknown", async () => {
    const a = await make("A");
    await make("B");
    expect(await updateFolder(t.db, a, { name: "a", description: "d" })).toMatchObject({
      ok: true,
      folder: { name: "a", description: "d" },
    });
    expect(await updateFolder(t.db, a, { name: "b" })).toMatchObject({ ok: false, status: 409 });
    expect(await updateFolder(t.db, a, { description: "" })).toMatchObject({
      ok: true,
      folder: { name: "a", description: null },
    });
    expect(await updateFolder(t.db, 99999, { name: "x" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await updateFolder(t.db, "1", { name: "x" })).toMatchObject({ ok: false, status: 404 });
    expect(await updateFolder(t.db, a, {})).toMatchObject({ ok: false, status: 400 });
    expect(await updateFolder(t.db, a, { name: "" })).toMatchObject({ ok: false, status: 400 });
    expect(await updateFolder(t.db, a, { isStarred: "yes" })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("stars at the end, keeps the place on repeat, unstars, and restars at the end", async () => {
    const [a, b, c] = [await make("A"), await make("B"), await make("C")];
    const place = async (id: number) =>
      (await listFolders(t.db)).find((f) => f.id === id)?.starPosition;
    await updateFolder(t.db, a, { isStarred: true });
    await updateFolder(t.db, b, { isStarred: true });
    await updateFolder(t.db, c, { isStarred: true });
    expect([await place(a), await place(b), await place(c)]).toEqual([0, 1, 2]);
    await updateFolder(t.db, a, { isStarred: true });
    expect(await place(a)).toBe(0);
    expect(await updateFolder(t.db, b, { isStarred: false })).toMatchObject({
      ok: true,
      folder: { starPosition: null, isStarred: false },
    });
    await updateFolder(t.db, b, { isStarred: true });
    expect(await place(b)).toBe(3);
    expect((await listFolders(t.db)).map((f) => f.id)).toEqual([a, c, b]);
  });

  it("deletes a folder; 404 for an unknown one", async () => {
    const a = await make("A");
    expect(await deleteFolder(t.db, a)).toEqual({ ok: true });
    expect(await deleteFolder(t.db, a)).toMatchObject({ ok: false, status: 404 });
    expect(await deleteFolder(t.db, "x")).toMatchObject({ ok: false, status: 404 });
    expect(await names()).toEqual([]);
  });

  it("reorders the starred folders to positions 0..n-1", async () => {
    const [a, b, c] = [await make("A"), await make("B"), await make("C")];
    for (const id of [a, b, c]) await updateFolder(t.db, id, { isStarred: true });
    await deleteFolder(t.db, a); // leaves a gap: places 1, 2
    expect(await reorderStarredFolders(t.db, [c, b])).toEqual({ ok: true, folderIds: [c, b] });
    expect(await listFolders(t.db)).toMatchObject([
      { id: c, starPosition: 0 },
      { id: b, starPosition: 1 },
    ]);
  });

  it("rejects a stale, duplicate, unknown or malformed reorder and writes nothing", async () => {
    const [a, b, c] = [await make("A"), await make("B"), await make("C")];
    await updateFolder(t.db, a, { isStarred: true });
    await updateFolder(t.db, b, { isStarred: true });
    const before = await listFolders(t.db);
    const cases: [unknown, number][] = [
      [[a], 409], // missing
      [[a, b, c], 409], // extra (unstarred)
      [[b, c], 409], // stale: swaps a for an unstarred one
      [[a, a], 400],
      [[a, 99999], 400],
      ["nope", 400],
      [[a, "b"], 400],
      [[0, a], 400],
    ];
    for (const [list, status] of cases) {
      expect(await reorderStarredFolders(t.db, list), JSON.stringify(list)).toMatchObject({
        ok: false,
        status,
      });
    }
    expect(await listFolders(t.db)).toEqual(before);
  });

  describe("repo membership", () => {
    const addRepo = async (githubId: number, name: string) => {
      const [row] = await t.db
        .insert(repos)
        .values({
          githubId,
          owner: "acme",
          name,
          defaultBranch: "main",
          visibility: "public",
          htmlUrl: `https://example.test/acme/${name}`,
        })
        .returning({ id: repos.id });
      return row!.id;
    };
    const folderOf = async (id: number) =>
      (await t.db.select({ f: repos.folderId }).from(repos).where(eq(repos.id, id)))[0]?.f;

    beforeEach(async () => {
      await t.db.delete(repos);
    });

    it("assigns, moves and clears a repo's folder", async () => {
      const [a, b] = [await make("A"), await make("B")];
      const repo = await addRepo(1, "one");
      expect(await updateRepoFlags(t.db, "acme", "one", { folderId: a })).toMatchObject({
        ok: true,
        folderId: a,
      });
      expect(await folderOf(repo)).toBe(a);
      await updateRepoFlags(t.db, "ACME", "ONE", { folderId: b });
      expect(await folderOf(repo)).toBe(b);
      expect(await updateRepoFlags(t.db, "acme", "one", { folderId: null })).toMatchObject({
        ok: true,
        folderId: null,
      });
      expect(await folderOf(repo)).toBeNull();
    });

    it("rejects an unknown folder (404) or a bad type (400) without writing; other flags still work alone", async () => {
      const a = await make("A");
      const repo = await addRepo(2, "two");
      await updateRepoFlags(t.db, "acme", "two", { folderId: a });
      expect(await updateRepoFlags(t.db, "acme", "two", { folderId: 99999 })).toMatchObject({
        ok: false,
        status: 404,
      });
      for (const bad of ["1", 0, -1, 1.5, true]) {
        expect(await updateRepoFlags(t.db, "acme", "two", { folderId: bad })).toMatchObject({
          ok: false,
          status: 400,
        });
      }
      // A valid isAllowed with an unknown folder writes neither.
      await updateRepoFlags(t.db, "acme", "two", { isAllowed: false, folderId: 99999 });
      const [row] = await t.db.select().from(repos).where(eq(repos.id, repo));
      expect(row).toMatchObject({ isAllowed: true, folderId: a });
      expect(await updateRepoFlags(t.db, "acme", "two", { isAllowed: false })).toMatchObject({
        ok: true,
        isAllowed: false,
        folderId: a,
      });
    });

    it("keeps repos, their allowed flag and star when a folder is deleted; blocking keeps the folder", async () => {
      const [a, b] = [await make("A"), await make("B")];
      const repo = await addRepo(3, "three");
      await updateRepoFlags(t.db, "acme", "three", { folderId: a, isStarred: true });
      await updateRepoFlags(t.db, "acme", "three", { isAllowed: false });
      await updateRepoFlags(t.db, "acme", "three", { isAllowed: true });
      expect(await folderOf(repo)).toBe(a);
      for (const id of [a, b]) await updateFolder(t.db, id, { isStarred: true });
      await deleteFolder(t.db, a);
      const [row] = await t.db.select().from(repos).where(eq(repos.id, repo));
      expect(row).toMatchObject({ folderId: null, isAllowed: true, starPosition: 0 });
      expect((await listFolders(t.db)).map((f) => f.id)).toEqual([b]);
    });
  });
});
