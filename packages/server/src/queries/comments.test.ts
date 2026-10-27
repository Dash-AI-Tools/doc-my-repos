import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../db/client";
import { docComments, documents, repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  countDocComments,
  COMMENTS_PAGE_SIZE,
  getCommentDocument,
  getCommentStates,
  getCommentTarget,
  getCommentThread,
  isCommentCursor,
  listCommentsForModeration,
  listDocComments,
} from "./comments";
import { allowAllRepos } from "./visibility";

const PATH = "docs/guide.md";

async function addRepo(db: Db, githubId: number, name: string, isAllowed = true): Promise<number> {
  const [row] = await db
    .insert(repos)
    .values({
      githubId,
      owner: "acme",
      name,
      defaultBranch: "main",
      visibility: "public",
      htmlUrl: `https://github.com/acme/${name}`,
      isAllowed,
    })
    .returning({ id: repos.id });
  return row!.id;
}

async function addDoc(db: Db, repoId: number, path: string): Promise<void> {
  await db
    .insert(documents)
    .values({ repoId, path, title: path, blobSha: `sha-${path}`, sizeBytes: 1, body: "x" });
}

let clock = 0;
/** Strictly increasing creation times, so ordering does not depend on the wall clock. */
async function addComment(
  db: Db,
  values: Partial<typeof docComments.$inferInsert> & { githubRepoId: number },
): Promise<number> {
  clock += 1;
  const [row] = await db
    .insert(docComments)
    .values({
      path: PATH,
      authorLabel: "ana",
      body: `comment ${clock}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)),
      ...values,
    })
    .returning({ id: docComments.id });
  return row!.id;
}

async function softDelete(db: Db, id: number): Promise<void> {
  await db
    .update(docComments)
    .set({ deletedAt: new Date(), body: "" })
    .where(eq(docComments.id, id));
}

describeDb("comment queries", () => {
  let t: TestDatabase;
  let db: Db;
  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  describe("listDocComments", () => {
    const GH = 1001;
    let repoId: number;
    beforeAll(async () => {
      repoId = await addRepo(db, GH, "list");
      await addDoc(db, repoId, PATH);
      await addDoc(db, repoId, "docs/other.md");
    });

    it("returns roots oldest first with replies, ignoring other documents", async () => {
      const a = await addComment(db, { githubRepoId: GH, path: "docs/order.md" });
      await addDoc(db, repoId, "docs/order.md");
      const b = await addComment(db, { githubRepoId: GH, path: "docs/order.md" });
      const r2 = await addComment(db, { githubRepoId: GH, path: "docs/order.md", parentId: a });
      const r1 = await addComment(db, { githubRepoId: GH, path: "docs/order.md", parentId: a });
      await addComment(db, { githubRepoId: GH, path: "docs/other.md" });
      const page = await listDocComments(db, { repo: { id: repoId }, path: "docs/order.md" });
      expect(page.threads.map((x) => x.root.id)).toEqual([a, b]);
      expect(page.threads[0]?.replies.map((x) => x.id)).toEqual([r2, r1]);
      expect(page.threads[1]?.replies).toEqual([]);
      expect(page.nextCursor).toBeNull();
      const byName = await listDocComments(db, {
        repo: { owner: "ACME", name: "List" },
        path: "docs/order.md",
      });
      expect(byName.threads).toHaveLength(2);
    });

    it("pages roots 50 at a time with a cursor, without gaps or repeats", async () => {
      await addDoc(db, repoId, "docs/paged.md");
      const ids: number[] = [];
      for (let i = 0; i < 120; i++) {
        ids.push(await addComment(db, { githubRepoId: GH, path: "docs/paged.md" }));
      }
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await listDocComments(db, {
          repo: { id: repoId },
          path: "docs/paged.md",
          cursor,
        });
        expect(page.threads.length).toBeLessThanOrEqual(COMMENTS_PAGE_SIZE);
        seen.push(...page.threads.map((x) => x.root.id));
        cursor = page.nextCursor;
        if (cursor !== null) expect(isCommentCursor(cursor)).toBe(true);
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(3);
      expect(seen).toEqual(ids);
    });

    it("keeps comments created in the same millisecond in id order across pages", async () => {
      await addDoc(db, repoId, "docs/same.md");
      const at = new Date("2026-02-02T00:00:00.123Z");
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await addComment(db, { githubRepoId: GH, path: "docs/same.md", createdAt: at }));
      }
      const first = await listDocComments(db, {
        repo: { id: repoId },
        path: "docs/same.md",
        limit: 2,
      });
      const second = await listDocComments(db, {
        repo: { id: repoId },
        path: "docs/same.md",
        limit: 2,
        cursor: first.nextCursor,
      });
      expect([...first.threads, ...second.threads].map((x) => x.root.id)).toEqual(ids.slice(0, 4));
    });

    it("applies the placeholder rules for deleted comments", async () => {
      await addDoc(db, repoId, "docs/ph.md");
      const p = "docs/ph.md";
      const gone = await addComment(db, { githubRepoId: GH, path: p });
      await softDelete(db, gone);
      const placeholder = await addComment(db, { githubRepoId: GH, path: p });
      const live = await addComment(db, { githubRepoId: GH, path: p, parentId: placeholder });
      const deletedReply = await addComment(db, {
        githubRepoId: GH,
        path: p,
        parentId: placeholder,
      });
      await softDelete(db, deletedReply);
      await softDelete(db, placeholder);
      const onlyDeletedChildren = await addComment(db, { githubRepoId: GH, path: p });
      const child = await addComment(db, {
        githubRepoId: GH,
        path: p,
        parentId: onlyDeletedChildren,
      });
      await softDelete(db, child);
      await softDelete(db, onlyDeletedChildren);

      const page = await listDocComments(db, { repo: { id: repoId }, path: p });
      expect(page.threads.map((x) => x.root.id)).toEqual([placeholder]);
      const root = page.threads[0]!.root;
      expect(root).toMatchObject({ deleted: true, body: "", authorLabel: "", authorId: null });
      expect(page.threads[0]!.replies.map((x) => x.id)).toEqual([live]);
      expect(await countDocComments(db, { repo: { id: repoId }, path: p })).toEqual({
        comments: 1,
        openThreads: 1,
      });
    });

    it("counts live comments and open threads, resolved threads excluded from open", async () => {
      await addDoc(db, repoId, "docs/count.md");
      const p = "docs/count.md";
      const open = await addComment(db, { githubRepoId: GH, path: p });
      await addComment(db, { githubRepoId: GH, path: p, parentId: open });
      await addComment(db, { githubRepoId: GH, path: p, resolvedAt: new Date() });
      expect(await countDocComments(db, { repo: { id: repoId }, path: p })).toEqual({
        comments: 3,
        openThreads: 1,
      });
    });

    it("includes the author email only on request, and a removed author keeps the label", async () => {
      await addDoc(db, repoId, "docs/email.md");
      const [u] = await db
        .insert(users)
        .values({ email: "ana@example.com", passwordHash: "x" })
        .returning({ id: users.id });
      await addComment(db, {
        githubRepoId: GH,
        path: "docs/email.md",
        authorId: u!.id,
        authorLabel: "ana",
      });
      const args = { repo: { id: repoId }, path: "docs/email.md" };
      expect((await listDocComments(db, args)).threads[0]?.root.authorEmail).toBeNull();
      const admin = await listDocComments(db, { ...args, includeEmail: true });
      expect(admin.threads[0]?.root.authorEmail).toBe("ana@example.com");
      await db.delete(users).where(eq(users.id, u!.id));
      const after = await listDocComments(db, { ...args, includeEmail: true });
      expect(after.threads[0]?.root).toMatchObject({
        authorId: null,
        authorLabel: "ana",
        authorEmail: null,
      });
    });

    it("returns nothing for an orphaned document, bad input and a bad cursor", async () => {
      await addComment(db, { githubRepoId: GH, path: "docs/missing.md" });
      const args = { repo: { id: repoId }, path: "docs/missing.md" };
      expect((await listDocComments(db, args)).threads).toEqual([]);
      expect(await countDocComments(db, args)).toEqual({ comments: 0, openThreads: 0 });
      expect((await listDocComments(db, { ...args, path: "" })).threads).toEqual([]);
      expect((await listDocComments(db, { ...args, path: "a\u0000b" })).threads).toEqual([]);
      const bad = await listDocComments(db, { ...args, path: PATH, cursor: "nonsense" });
      expect(bad).toEqual({ threads: [], nextCursor: null });
      expect(isCommentCursor("1|2")).toBe(false);
    });

    it("finds the thread of a root, hiding a deleted root without live replies", async () => {
      const root = await addComment(db, { githubRepoId: GH });
      const reply = await addComment(db, { githubRepoId: GH, parentId: root });
      const thread = await getCommentThread(db, root);
      expect(thread?.root.id).toBe(root);
      expect(thread?.replies.map((x) => x.id)).toEqual([reply]);
      expect(await getCommentThread(db, reply)).toBeNull();
      await softDelete(db, reply);
      await softDelete(db, root);
      expect(await getCommentThread(db, root)).toBeNull();
    });
  });

  describe("visibility and churn", () => {
    const GH = 2002;
    const p = "docs/churn.md";
    it("hides comments of a blocked repository and restores them without a write", async () => {
      const repoId = await addRepo(db, GH, "churn");
      await addDoc(db, repoId, p);
      const root = await addComment(db, { githubRepoId: GH, path: p });
      const args = { repo: { id: repoId }, path: p };
      expect((await listDocComments(db, args)).threads).toHaveLength(1);

      await db.update(repos).set({ isAllowed: false }).where(eq(repos.id, repoId));
      expect((await listDocComments(db, args)).threads).toEqual([]);
      expect((await countDocComments(db, args)).comments).toBe(0);
      expect(await getCommentTarget(db, root)).toBeNull();
      expect(await getCommentThread(db, root)).toBeNull();
      expect(await getCommentDocument(db, args)).toBeNull();
      expect(await getCommentStates(db, { ids: [root] })).toEqual([]);
      const mod = await listCommentsForModeration(db, { githubRepoId: GH });
      expect(mod.items).toEqual([]);
      // Admins see it, marked blocked.
      const admin = await listCommentsForModeration(
        db,
        { githubRepoId: GH },
        { visibility: allowAllRepos },
      );
      expect(admin.items.map((x) => [x.id, x.state])).toEqual([[root, "blocked"]]);

      const before = await db.select().from(docComments).where(eq(docComments.id, root));
      await db.update(repos).set({ isAllowed: true }).where(eq(repos.id, repoId));
      expect((await listDocComments(db, args)).threads).toHaveLength(1);
      const after = await db.select().from(docComments).where(eq(docComments.id, root));
      expect(after).toEqual(before);
    });

    it("hides comments while a document is missing and restores them when it returns", async () => {
      const repoId = await addRepo(db, GH + 1, "docchurn");
      await addDoc(db, repoId, p);
      await addComment(db, { githubRepoId: GH + 1, path: p });
      const args = { repo: { id: repoId }, path: p };
      await db.delete(documents).where(eq(documents.repoId, repoId));
      expect((await listDocComments(db, args)).threads).toEqual([]);
      await addDoc(db, repoId, p);
      expect((await listDocComments(db, args)).threads).toHaveLength(1);
    });

    it("restores comments for a removed and re-added repository (new id, same github id)", async () => {
      const oldId = await addRepo(db, GH + 2, "readd");
      await addDoc(db, oldId, p);
      const root = await addComment(db, { githubRepoId: GH + 2, path: p });
      await db.delete(repos).where(eq(repos.id, oldId));
      // The comment survives the repository's removal and is an orphan meanwhile.
      expect(await db.select().from(docComments).where(eq(docComments.id, root))).toHaveLength(1);
      const orphan = await listCommentsForModeration(
        db,
        { githubRepoId: GH + 2 },
        { visibility: allowAllRepos },
      );
      expect(orphan.items.map((x) => [x.state, x.owner])).toEqual([["orphaned", null]]);

      const newId = await addRepo(db, GH + 2, "readd");
      expect(newId).not.toBe(oldId);
      await addDoc(db, newId, p);
      const page = await listDocComments(db, { repo: { owner: "acme", name: "readd" }, path: p });
      expect(page.threads.map((x) => x.root.id)).toEqual([root]);
    });
  });

  describe("moderation reads", () => {
    const GH = 3003;
    let repoId: number;
    const ids: Record<string, number> = {};
    beforeAll(async () => {
      repoId = await addRepo(db, GH, "mod");
      await addDoc(db, repoId, "docs/m.md");
      const blockedRepo = await addRepo(db, GH + 1, "modblocked", false);
      await addDoc(db, blockedRepo, "docs/b.md");
      ids.live = await addComment(db, { githubRepoId: GH, path: "docs/m.md", body: "live" });
      ids.deleted = await addComment(db, { githubRepoId: GH, path: "docs/m.md" });
      await softDelete(db, ids.deleted);
      ids.orphanDoc = await addComment(db, { githubRepoId: GH, path: "docs/gone.md" });
      ids.orphanRepo = await addComment(db, { githubRepoId: GH + 50, path: "docs/x.md" });
      ids.blocked = await addComment(db, { githubRepoId: GH + 1, path: "docs/b.md" });
    });

    it("classifies live, deleted, orphaned and blocked for trusted callers", async () => {
      const all = await listCommentsForModeration(
        db,
        { limit: 100 },
        { visibility: allowAllRepos },
      );
      const states = new Map(all.items.map((x) => [x.id, x.state]));
      expect(states.get(ids.live!)).toBe("live");
      expect(states.get(ids.deleted!)).toBe("deleted");
      expect(states.get(ids.orphanDoc!)).toBe("orphaned");
      expect(states.get(ids.orphanRepo!)).toBe("orphaned");
      expect(states.get(ids.blocked!)).toBe("blocked");
      // Newest first.
      const times = all.items.map((x) => x.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const live = all.items.find((x) => x.id === ids.live);
      expect(live).toMatchObject({ owner: "acme", name: "mod", body: "live", deleted: false });
      expect(all.items.find((x) => x.id === ids.deleted)).toMatchObject({
        body: "",
        deleted: true,
      });
    });

    it("filters by state and repository and pages with a cursor", async () => {
      const opts = { visibility: allowAllRepos };
      const only = async (state: "live" | "deleted" | "orphaned" | "blocked") =>
        (await listCommentsForModeration(db, { state, githubRepoId: undefined }, opts)).items
          .map((x) => x.id)
          .filter((id) => Object.values(ids).includes(id));
      expect(await only("orphaned")).toEqual([ids.orphanRepo, ids.orphanDoc]);
      expect(await only("blocked")).toEqual([ids.blocked]);
      expect(await only("deleted")).toEqual([ids.deleted]);
      const byRepo = await listCommentsForModeration(db, { githubRepoId: GH + 50 }, opts);
      expect(byRepo.items.map((x) => x.id)).toEqual([ids.orphanRepo]);

      const first = await listCommentsForModeration(db, { githubRepoId: GH, limit: 2 }, opts);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await listCommentsForModeration(
        db,
        { githubRepoId: GH, limit: 2, cursor: first.nextCursor },
        opts,
      );
      expect(second.items.map((x) => x.id)).toEqual([ids.live]);
      expect(second.nextCursor).toBeNull();
    });

    it("shows orphans only to a caller that passes allowAllRepos explicitly", async () => {
      const def = await listCommentsForModeration(db, { limit: 100 });
      const seen = def.items.map((x) => x.id);
      expect(seen).toContain(ids.live);
      expect(seen).toContain(ids.deleted);
      expect(seen).not.toContain(ids.orphanDoc);
      expect(seen).not.toContain(ids.orphanRepo);
      expect(seen).not.toContain(ids.blocked);
      expect(await getCommentTarget(db, ids.orphanDoc!)).toBeNull();
      expect(await getCommentTarget(db, ids.orphanDoc!, { includeOrphans: true })).toBeNull();
      const target = await getCommentTarget(db, ids.orphanDoc!, {
        includeOrphans: true,
        visibility: allowAllRepos,
      });
      expect(target).toMatchObject({ state: "orphaned", path: "docs/gone.md" });
    });

    it("returns the states of selected comments", async () => {
      const opts = { visibility: allowAllRepos };
      const byIds = await getCommentStates(
        db,
        { ids: [ids.live!, ids.deleted!, ids.orphanDoc!, ids.blocked!, -5, 0] },
        opts,
      );
      expect(byIds.map((x) => x.state)).toEqual(["live", "deleted", "orphaned", "blocked"]);
      const byDoc = await getCommentStates(db, { githubRepoId: GH, path: "docs/gone.md" }, opts);
      expect(byDoc).toEqual([
        { id: ids.orphanDoc, state: "orphaned", deleted: false, hasLiveReplies: false },
      ]);
      expect(await getCommentStates(db, { ids: [] }, opts)).toEqual([]);
    });
  });

  describe("getCommentTarget", () => {
    it("reports ownership, thread root and reply state", async () => {
      const repoId = await addRepo(db, 4004, "target");
      await addDoc(db, repoId, PATH);
      const root = await addComment(db, { githubRepoId: 4004, asOrg: true });
      const reply = await addComment(db, { githubRepoId: 4004, parentId: root });
      expect(await getCommentTarget(db, root)).toMatchObject({
        id: root,
        rootId: root,
        parentId: null,
        asOrg: true,
        deleted: false,
        hasLiveReplies: true,
        resolved: false,
        state: "live",
        githubRepoId: 4004,
        path: PATH,
        owner: "acme",
        name: "target",
      });
      expect(await getCommentTarget(db, reply)).toMatchObject({
        rootId: root,
        hasLiveReplies: false,
      });
      expect(await getCommentTarget(db, 999_999_999)).toBeNull();
      expect(await getCommentTarget(db, 1.5)).toBeNull();
    });
  });
});
