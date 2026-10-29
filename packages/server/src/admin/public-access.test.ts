import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DomainEventInput } from "@docmyrepos/core";

import type { Access } from "../auth/access";
import { repoFolders, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { listRepoIds } from "../queries";
import { anonymousReposOnly } from "../queries/visibility";
import { createFolder, updateFolder } from "./folders";
import { handleUpdateFolder, handleUpdateRepo } from "./service";

/**
 * The Public switches of the admin actions (public-access): repositories and folders, the
 * confirmation for repositories that are private on GitHub, who may flip them, the events, and
 * what an anonymous reader then sees.
 */

const admin = { id: 1, email: "admin@example.com", role: "admin" as const };

function accessFor(allowed: boolean): { access: Access; events: DomainEventInput[] } {
  const events: DomainEventInput[] = [];
  const denied = Object.assign(new Error("forbidden"), { status: 403 });
  const access: Access = {
    user: async () => admin,
    admin: async () => {
      if (!allowed) throw denied;
      return admin;
    },
    can: async () => allowed,
    emit: (event) => void events.push(event),
  };
  return { access, events };
}

const patch = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describeDb("public access switches", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.delete(repos);
    await t.db.delete(repoFolders);
  });

  const addRepo = async (githubId: number, name: string, visibility: "public" | "private") => {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner: "acme",
        name,
        defaultBranch: "main",
        visibility,
        htmlUrl: `https://github.com/acme/${name}`,
      })
      .returning({ id: repos.id });
    return row!.id;
  };
  const anonymousIds = () => listRepoIds(t.db, { visibility: anonymousReposOnly });
  const repo = async (id: number) => (await t.db.select().from(repos).where(eq(repos.id, id)))[0]!;
  const makeFolder = async (name: string) => {
    const r = await createFolder(t.db, { name });
    if (!r.ok) throw new Error(r.error);
    return r.folder.id;
  };

  describe("repositories", () => {
    it("turns public access on and off, emits an event for each change only, and returns it", async () => {
      const id = await addRepo(1, "docs", "public");
      const { access, events } = accessFor(true);
      const on = await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "docs", isPublic: true }),
        t.db,
        access,
      );
      expect(on.status).toBe(200);
      expect(((await on.json()) as { repo: { isPublic: boolean } }).repo.isPublic).toBe(true);
      expect(await anonymousIds()).toEqual([id]);
      // Repeating it changes nothing and emits nothing.
      await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "docs", isPublic: true }),
        t.db,
        access,
      );
      const off = await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "docs", isPublic: false }),
        t.db,
        access,
      );
      expect(off.status).toBe(200);
      expect(await anonymousIds()).toEqual([]);
      expect(events.map((e) => [e.name, e.payload])).toEqual([
        ["repo.public_changed", { githubRepoId: 1, public: true }],
        ["repo.public_changed", { githubRepoId: 1, public: false }],
      ]);
    });

    it("needs confirmation for a repository that is private on GitHub, and writes nothing without it", async () => {
      const id = await addRepo(2, "secret", "private");
      const { access, events } = accessFor(true);
      const refused = await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "secret", isPublic: true }),
        t.db,
        access,
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "confirm_private", privateRepos: 1 });
      expect((await repo(id)).isPublic).toBe(false);
      expect(events).toEqual([]);

      const confirmed = await handleUpdateRepo(
        patch("/api/admin/repos", {
          owner: "acme",
          name: "secret",
          isPublic: true,
          confirmPrivate: true,
        }),
        t.db,
        access,
      );
      expect(confirmed.status).toBe(200);
      expect(await anonymousIds()).toEqual([id]);

      // Turning it off never asks.
      const off = await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "secret", isPublic: false }),
        t.db,
        access,
      );
      expect(off.status).toBe(200);
    });

    it("answers 403 to a non-admin and changes nothing", async () => {
      const id = await addRepo(3, "docs3", "public");
      const { access, events } = accessFor(false);
      const response = await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "docs3", isPublic: true }),
        t.db,
        access,
      );
      expect(response.status).toBe(403);
      expect((await repo(id)).isPublic).toBe(false);
      expect(events).toEqual([]);
    });

    it("rejects a non-boolean isPublic or confirmPrivate with 400", async () => {
      await addRepo(4, "docs4", "public");
      const { access } = accessFor(true);
      for (const body of [{ isPublic: "yes" }, { isPublic: true, confirmPrivate: 1 }]) {
        const response = await handleUpdateRepo(
          patch("/api/admin/repos", { owner: "acme", name: "docs4", ...body }),
          t.db,
          access,
        );
        expect(response.status).toBe(400);
      }
    });

    it("can mark a blocked repository, which stays hidden from everyone until allowed", async () => {
      const id = await addRepo(5, "blocked", "public");
      await t.db.update(repos).set({ isAllowed: false }).where(eq(repos.id, id));
      const { access } = accessFor(true);
      const response = await handleUpdateRepo(
        patch("/api/admin/repos", { owner: "acme", name: "blocked", isPublic: true }),
        t.db,
        access,
      );
      expect(response.status).toBe(200);
      expect(await anonymousIds()).toEqual([]);
      await t.db.update(repos).set({ isAllowed: true }).where(eq(repos.id, id));
      expect(await anonymousIds()).toEqual([id]);
    });
  });

  describe("folders", () => {
    it("makes the repositories of a folder public, including ones added later and not ones moved out", async () => {
      const folder = await makeFolder("Open source");
      const first = await addRepo(10, "one", "public");
      const second = await addRepo(11, "two", "public");
      await t.db.update(repos).set({ folderId: folder }).where(eq(repos.id, first));
      const { access, events } = accessFor(true);
      const response = await handleUpdateFolder(
        folder,
        patch(`/api/admin/folders/${folder}`, { isPublic: true }),
        t.db,
        access,
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { folder: { isPublic: boolean } }).folder.isPublic).toBe(
        true,
      );
      expect(await anonymousIds()).toEqual([first]);
      await t.db.update(repos).set({ folderId: folder }).where(eq(repos.id, second));
      expect((await anonymousIds()).sort()).toEqual([first, second].sort());
      await t.db.update(repos).set({ folderId: null }).where(eq(repos.id, first));
      expect(await anonymousIds()).toEqual([second]);
      expect(events.map((e) => [e.name, e.payload])).toEqual([
        ["folder.public_changed", { folderId: folder, public: true }],
      ]);
    });

    it("counts the allowed GitHub-private repositories and needs confirmation for them", async () => {
      const folder = await makeFolder("Mixed");
      const a = await addRepo(20, "pa", "private");
      const b = await addRepo(21, "pb", "private");
      const blocked = await addRepo(22, "pc", "private");
      const open = await addRepo(23, "pd", "public");
      await t.db.update(repos).set({ folderId: folder }).where(eq(repos.owner, "acme"));
      await t.db.update(repos).set({ isAllowed: false }).where(eq(repos.id, blocked));
      const { access } = accessFor(true);
      const refused = await handleUpdateFolder(
        folder,
        patch(`/api/admin/folders/${folder}`, { isPublic: true }),
        t.db,
        access,
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "confirm_private", privateRepos: 2 });
      expect(await anonymousIds()).toEqual([]);

      const confirmed = await handleUpdateFolder(
        folder,
        patch(`/api/admin/folders/${folder}`, { isPublic: true, confirmPrivate: true }),
        t.db,
        access,
      );
      expect(confirmed.status).toBe(200);
      expect(new Set(await anonymousIds())).toEqual(new Set([a, b, open]));
    });

    it("keeps the mark on rename and star, drops its effect when the folder is deleted", async () => {
      const folder = await makeFolder("Keep");
      const id = await addRepo(30, "kept", "public");
      await t.db.update(repos).set({ folderId: folder }).where(eq(repos.id, id));
      expect(await updateFolder(t.db, folder, { isPublic: true })).toMatchObject({ ok: true });
      expect(await updateFolder(t.db, folder, { name: "Renamed", isStarred: true })).toMatchObject({
        ok: true,
        folder: { isPublic: true },
      });
      expect(await anonymousIds()).toEqual([id]);
      await t.db.delete(repoFolders).where(eq(repoFolders.id, folder));
      expect(await anonymousIds()).toEqual([]);
      expect((await repo(id)).isPublic).toBe(false);
    });

    it("answers 403 to a non-admin and changes nothing", async () => {
      const folder = await makeFolder("Nope");
      const { access } = accessFor(false);
      const response = await handleUpdateFolder(
        folder,
        patch(`/api/admin/folders/${folder}`, { isPublic: true }),
        t.db,
        access,
      );
      expect(response.status).toBe(403);
      const [row] = await t.db.select().from(repoFolders).where(eq(repoFolders.id, folder));
      expect(row?.isPublic).toBe(false);
    });

    it("rejects a non-boolean isPublic with 400 and an empty patch is still refused", async () => {
      const folder = await makeFolder("Bad");
      expect(await updateFolder(t.db, folder, { isPublic: "yes" })).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(await updateFolder(t.db, folder, {})).toMatchObject({ ok: false, status: 400 });
    });
  });
});

vi.mock("server-only", () => ({}));
