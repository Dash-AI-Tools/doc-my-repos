import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { newSessionPayload, SESSION_COOKIE, signSession } from "../auth/session";
import type { CurrentUser } from "../auth/current-user";
import { docComments, documents, repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { recordingLogger, type RecordingLogger } from "../test-logger";
import {
  adminDelete,
  adminPurge,
  createComment,
  deleteComment,
  DOCUMENT_CAP,
  editComment,
  patchComment,
  RATE_LIMIT,
  setResolved,
  type CommentDeps,
} from "./service";
import { commentResponse, type CommentResult, type PurgeResult } from "./results";

const SECRET = "comments-service-test-secret-0123456789";

const jar = vi.hoisted(() => ({ cookie: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined,
  }),
}));

const ORIGIN = "http://localhost";

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fail(result: CommentResult | PurgeResult) {
  if (result.ok) throw new Error("expected a failure");
  return result;
}
function ok(result: CommentResult | PurgeResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.status} ${result.code}`);
  return result;
}
function okChange(result: CommentResult) {
  const r = ok(result);
  if (!("comment" in r)) throw new Error("expected a change");
  return r;
}

describeDb("comment write handlers", () => {
  let t: TestDatabase;
  const ids: Record<string, number> = {};
  let rec: RecordingLogger;
  let enabled = true;
  let docCounter = 0;
  let deps: CommentDeps;

  function as(name: string | null) {
    const role = name?.startsWith("root") ? "admin" : "user";
    jar.cookie = name === null ? "" : signSession(SECRET, newSessionPayload(ids[name]!, role, 0));
  }

  /** A fresh document in the visible repository, so tests do not share caps or threads. */
  async function freshDoc(): Promise<string> {
    docCounter += 1;
    const path = `docs/doc-${docCounter}.md`;
    await t.db.insert(documents).values({
      repoId: ids.repo!,
      path,
      title: path,
      blobSha: `sha-${docCounter}`,
      sizeBytes: 1,
      body: "x",
    });
    return path;
  }

  async function post(
    path: string,
    body: string,
    extra: Record<string, unknown> = {},
  ): Promise<CommentResult> {
    return createComment(
      req("POST", "/api/comments", { repo: "acme/handbook", path, body, ...extra }),
      deps,
    );
  }
  async function postId(path: string, body: string, extra: Record<string, unknown> = {}) {
    return okChange(await post(path, body, extra)).comment!.id;
  }
  const rows = (path: string) =>
    t.db.select().from(docComments).where(eq(docComments.path, path)).orderBy(docComments.id);

  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    t = await createTestDatabase();
    const made = await t.db
      .insert(users)
      .values(
        ["ana@example.com", "bob@example.com", "root@example.com", "root2@example.com"].map(
          (email) => ({
            email,
            passwordHash: "x",
            role: email.startsWith("root") ? ("admin" as const) : ("user" as const),
          }),
        ),
      )
      .returning({ id: users.id, email: users.email });
    for (const u of made) ids[u.email.split("@")[0]!] = u.id;
    const extra = await t.db
      .insert(users)
      .values([
        { email: "off@example.com", passwordHash: "x", disabled: true },
        { email: "limited@example.com", passwordHash: "x" },
        { email: "capper@example.com", passwordHash: "x" },
        ...Array.from({ length: 6 }, (_, i) => ({
          email: `racer${i}@example.com`,
          passwordHash: "x",
        })),
      ])
      .returning({ id: users.id, email: users.email });
    for (const u of extra) ids[u.email.split("@")[0]!] = u.id;

    const [repo] = await t.db
      .insert(repos)
      .values({
        githubId: 1,
        owner: "acme",
        name: "handbook",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/handbook",
      })
      .returning({ id: repos.id });
    ids.repo = repo!.id;
    const [blocked] = await t.db
      .insert(repos)
      .values({
        githubId: 2,
        owner: "acme",
        name: "secret",
        defaultBranch: "main",
        visibility: "private",
        htmlUrl: "https://github.com/acme/secret",
        isAllowed: false,
      })
      .returning({ id: repos.id });
    await t.db.insert(documents).values({
      repoId: blocked!.id,
      path: "docs/s.md",
      title: "s",
      blobSha: "s",
      sizeBytes: 1,
      body: "x",
    });
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    // Move earlier tests' comments out of every user's rate window (order within a thread is kept).
    await t.db
      .update(docComments)
      .set({ createdAt: sql`created_at - interval '1 day'` })
      .where(sql`created_at > now() - interval '12 hours'`);
    rec = recordingLogger();
    enabled = true;
    deps = { db: t.db, enabled: () => enabled, log: rec.log };
    as("ana");
  });

  describe("gates: flag, session, origin, body", () => {
    it("answers 404 for every write when comments are off, even signed out", async () => {
      enabled = false;
      as(null);
      const path = "docs/x.md";
      expect(fail(await post(path, "hi")).status).toBe(404);
      expect(fail(await editComment(req("PATCH", "/x", { body: "a" }), "1", deps)).status).toBe(
        404,
      );
      expect(
        fail(await setResolved(req("PATCH", "/x", { resolved: true }), "1", deps)).status,
      ).toBe(404);
      expect(fail(await patchComment(req("PATCH", "/x", { body: "a" }), "1", deps)).status).toBe(
        404,
      );
      expect(fail(await deleteComment(req("DELETE", "/x"), "1", deps)).status).toBe(404);
    });

    it("answers 401 without a session and for a disabled user", async () => {
      const path = await freshDoc();
      as(null);
      const r = fail(await post(path, "hi"));
      expect([r.status, r.code]).toEqual([401, "unauthorized"]);
      expect(fail(await deleteComment(req("DELETE", "/x"), "1", deps)).status).toBe(401);
      jar.cookie = signSession(SECRET, newSessionPayload(ids.off!, "user", 0));
      expect(fail(await post(path, "hi")).status).toBe(401);
      expect(await rows(path)).toEqual([]);
    });

    it("refuses a foreign origin, cross-site fetch metadata and non-JSON bodies with 403", async () => {
      const path = await freshDoc();
      const body = { repo: "acme/handbook", path, body: "hi" };
      const foreign = createComment(
        req("POST", "/api/comments", body, { Origin: "https://evil.example.net" }),
        deps,
      );
      expect(fail(await foreign)).toMatchObject({ status: 403, code: "bad_origin" });
      const cross = createComment(
        req("POST", "/api/comments", body, { "Sec-Fetch-Site": "cross-site" }),
        deps,
      );
      expect(fail(await cross).status).toBe(403);
      const form = createComment(
        req("POST", "/api/comments", undefined, {
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        deps,
      );
      expect(fail(await form).status).toBe(403);
      expect(
        fail(
          await deleteComment(
            req("DELETE", "/x", undefined, { Origin: "https://evil.example.net" }),
            "1",
            deps,
          ),
        ).status,
      ).toBe(403);
      expect(await rows(path)).toEqual([]);
    });

    it("answers 400 naming the field for a bad body, and stores nothing", async () => {
      const path = await freshDoc();
      const bad = async (body: unknown) =>
        fail(await createComment(req("POST", "/api/comments", body), deps));
      const good = { repo: "acme/handbook", path, body: "hi" };
      expect(await bad({ ...good, asOrg: true })).toMatchObject({ status: 400, field: "asOrg" });
      expect(await bad({ ...good, path: undefined })).toMatchObject({ status: 400, field: "path" });
      expect(await bad({ ...good, repo: "nope" })).toMatchObject({ status: 400, field: "repo" });
      expect(await bad({ ...good, body: 5 })).toMatchObject({ status: 400, field: "body" });
      expect(await bad({ ...good, parentId: "1" })).toMatchObject({
        status: 400,
        field: "parentId",
      });
      expect(await bad({ ...good, parentId: -1 })).toMatchObject({ field: "parentId" });
      expect(await bad({ ...good, asOrganization: "yes" })).toMatchObject({
        field: "asOrganization",
      });
      expect(await bad([1])).toMatchObject({ status: 400 });
      expect(await bad(null)).toMatchObject({ status: 400 });
      const broken = new Request(`${ORIGIN}/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: "{not json",
      });
      expect(fail(await createComment(broken, deps))).toMatchObject({
        status: 400,
        code: "invalid_json",
      });
      expect(await rows(path)).toEqual([]);
    });

    it("rejects empty, whitespace-only and over-long text with a 400 on body", async () => {
      const path = await freshDoc();
      expect(fail(await post(path, "   \n\t "))).toMatchObject({ status: 400, field: "body" });
      expect(fail(await post(path, "‮​"))).toMatchObject({ status: 400, field: "body" });
      const long = fail(await post(path, "x".repeat(4001)));
      expect(long).toMatchObject({ status: 400, field: "body" });
      expect(long.error).toMatch(/4,000/);
      expect(ok(await post(path, "😀".repeat(4000))).status).toBe(201);
      expect(await rows(path)).toHaveLength(1);
    });

    it("answers 413 for an oversize body", async () => {
      const path = await freshDoc();
      const huge = { repo: "acme/handbook", path, body: "a".repeat(70_000) };
      expect(fail(await createComment(req("POST", "/api/comments", huge), deps))).toMatchObject({
        status: 413,
        code: "too_large",
      });
    });

    it("answers 404 for malformed ids", async () => {
      for (const id of ["abc", "0", "-1", "1.5", "01", "9".repeat(30), "", "1e3"]) {
        expect(fail(await deleteComment(req("DELETE", "/x"), id, deps)).status, id).toBe(404);
        expect(fail(await editComment(req("PATCH", "/x", { body: "a" }), id, deps)).status).toBe(
          404,
        );
      }
    });
  });

  describe("create", () => {
    it("stores the cleaned text under the author's display name and returns the thread", async () => {
      const path = await freshDoc();
      const result = okChange(await post(path, "  hello\r\nworld‮​  "));
      expect(result.status).toBe(201);
      expect(result.comment).toMatchObject({
        body: "hello\nworld",
        authorLabel: "ana",
        asOrg: false,
        parentId: null,
        deleted: false,
        authorId: ids.ana,
        authorEmail: null,
      });
      expect(result.thread?.root.id).toBe(result.comment?.id);
      const [row] = await rows(path);
      expect(row).toMatchObject({
        body: "hello\nworld",
        authorId: ids.ana,
        authorLabel: "ana",
        githubRepoId: 1,
        parentId: null,
        asOrg: false,
      });
    });

    it("lets a viewer comment, and shows admins the author's email", async () => {
      const path = await freshDoc();
      const root = await postId(path, "from a viewer");
      as("root");
      const res = okChange(await post(path, "from an admin", { parentId: root }));
      expect(res.thread?.root.authorEmail).toBe("ana@example.com");
      expect(res.comment?.authorEmail).toBe("root@example.com");
    });

    it("answers 404 for a document in a blocked repository, an unknown document and a missing parent", async () => {
      const blocked = fail(
        await createComment(
          req("POST", "/api/comments", { repo: "acme/secret", path: "docs/s.md", body: "x" }),
          deps,
        ),
      );
      expect(blocked).toMatchObject({ status: 404, code: "not_found" });
      expect(fail(await post("docs/none.md", "x")).status).toBe(404);
      expect(
        fail(
          await createComment(
            req("POST", "/api/comments", { repo: "acme/none", path: "docs/s.md", body: "x" }),
            deps,
          ),
        ).status,
      ).toBe(404);
      const path = await freshDoc();
      expect(fail(await post(path, "x", { parentId: 999_999_999 })).status).toBe(404);
      expect(
        await t.db.select().from(docComments).where(eq(docComments.path, "docs/s.md")),
      ).toEqual([]);
    });

    it("honours a flipped visibility filter (the document is looked up through the query layer)", async () => {
      const path = await freshDoc();
      const hidden: CommentDeps = { ...deps, options: { visibility: () => sql`false` } };
      const r = await createComment(
        req("POST", "/api/comments", { repo: "acme/handbook", path, body: "x" }),
        hidden,
      );
      expect(fail(r).status).toBe(404);
      expect(await rows(path)).toEqual([]);
    });

    it("attaches replies to the thread, and a reply to a reply to the same thread", async () => {
      const path = await freshDoc();
      const root = await postId(path, "root");
      as("bob");
      const reply = okChange(await post(path, "reply", { parentId: root }));
      expect(reply.comment?.parentId).toBe(root);
      const second = okChange(await post(path, "reply to reply", { parentId: reply.comment!.id }));
      expect(second.comment?.parentId).toBe(root);
      expect(second.thread?.replies.map((r) => r.body)).toEqual(["reply", "reply to reply"]);
    });

    it("refuses a reply to a deleted comment or to a comment of another document", async () => {
      const path = await freshDoc();
      const other = await freshDoc();
      const root = await postId(path, "root");
      const foreign = await postId(other, "elsewhere");
      expect(fail(await post(path, "x", { parentId: foreign })).status).toBe(404);
      okChange(await deleteComment(req("DELETE", `/api/comments/${root}`), String(root), deps));
      expect(fail(await post(path, "x", { parentId: root })).status).toBe(404);
    });

    it("reopens a resolved thread when someone replies", async () => {
      const path = await freshDoc();
      const root = await postId(path, "root");
      const resolved = okChange(
        await setResolved(req("PATCH", "/x", { resolved: true }), String(root), deps),
      );
      expect(resolved.thread?.root.resolvedAt).not.toBeNull();
      as("bob");
      const reply = okChange(await post(path, "still broken", { parentId: root }));
      expect(reply.thread?.root.resolvedAt).toBeNull();
      const [row] = await t.db.select().from(docComments).where(eq(docComments.id, root));
      expect(row?.resolvedAt).toBeNull();
      expect(row?.resolvedBy).toBeNull();
    });
  });

  describe("comment as the organization", () => {
    it("refuses a forged asOrganization from a non-admin with 403 and stores nothing", async () => {
      const path = await freshDoc();
      const r = fail(await post(path, "official", { asOrganization: true }));
      expect([r.status, r.code]).toEqual([403, "forbidden"]);
      expect(await rows(path)).toEqual([]);
      // asOrganization: false is fine for anyone.
      expect(ok(await post(path, "plain", { asOrganization: false })).status).toBe(201);
    });

    it("stores an admin's organization comment, still attributed to the admin", async () => {
      const path = await freshDoc();
      as("root");
      const res = okChange(await post(path, "official", { asOrganization: true }));
      expect(res.comment).toMatchObject({
        asOrg: true,
        authorLabel: "root",
        authorEmail: "root@example.com",
      });
    });

    it("lets any admin edit and delete an organization comment, not its non-admin readers", async () => {
      const path = await freshDoc();
      as("root");
      const id = await postId(path, "official", { asOrganization: true });
      as("root2");
      const edited = okChange(
        await editComment(req("PATCH", `/x`, { body: "corrected" }), String(id), deps),
      );
      expect(edited.comment).toMatchObject({ body: "corrected", asOrg: true });
      expect(edited.comment?.editedAt).not.toBeNull();
      as("bob");
      expect(
        fail(await editComment(req("PATCH", `/x`, { body: "mine now" }), String(id), deps)).status,
      ).toBe(403);
      expect(fail(await deleteComment(req("DELETE", `/x`), String(id), deps)).status).toBe(403);
      as("root2");
      expect(okChange(await deleteComment(req("DELETE", `/x`), String(id), deps)).removed).toBe(
        true,
      );
    });
  });

  describe("edit", () => {
    it("lets the author edit and marks it edited, cleaning the new text", async () => {
      const path = await freshDoc();
      const id = await postId(path, "first");
      const res = okChange(
        await editComment(req("PATCH", `/x`, { body: " second\u0000 " }), String(id), deps),
      );
      expect(res.status).toBe(200);
      expect(res.comment).toMatchObject({ body: "second" });
      expect(res.comment?.editedAt).toBeInstanceOf(Date);
      expect(res.thread?.root.id).toBe(id);
    });

    it("refuses someone else's edit with 403, including an admin on a personal comment", async () => {
      const path = await freshDoc();
      const id = await postId(path, "mine");
      as("bob");
      expect(
        fail(await editComment(req("PATCH", `/x`, { body: "x" }), String(id), deps)).status,
      ).toBe(403);
      as("root");
      const r = fail(await editComment(req("PATCH", `/x`, { body: "x" }), String(id), deps));
      expect([r.status, r.code]).toEqual([403, "forbidden"]);
      const [row] = await t.db.select().from(docComments).where(eq(docComments.id, id));
      expect(row).toMatchObject({ body: "mine", editedAt: null });
    });

    it("answers 404 for a hidden, deleted or unknown comment and 400 for bad text", async () => {
      const path = await freshDoc();
      const id = await postId(path, "mine");
      expect(
        fail(await editComment(req("PATCH", `/x`, { body: "" }), String(id), deps)),
      ).toMatchObject({ status: 400, field: "body" });
      expect(
        fail(await editComment(req("PATCH", `/x`, { body: "x", extra: 1 }), String(id), deps)),
      ).toMatchObject({ status: 400, field: "extra" });
      expect(
        fail(await editComment(req("PATCH", `/x`, { body: "x" }), "999999999", deps)).status,
      ).toBe(404);
      await t.db.update(repos).set({ isAllowed: false }).where(eq(repos.id, ids.repo!));
      try {
        expect(
          fail(await editComment(req("PATCH", `/x`, { body: "x" }), String(id), deps)).status,
        ).toBe(404);
        expect(fail(await deleteComment(req("DELETE", `/x`), String(id), deps)).status).toBe(404);
        expect(
          fail(await setResolved(req("PATCH", `/x`, { resolved: true }), String(id), deps)).status,
        ).toBe(404);
      } finally {
        await t.db.update(repos).set({ isAllowed: true }).where(eq(repos.id, ids.repo!));
      }
      okChange(await deleteComment(req("DELETE", `/x`), String(id), deps));
      expect(
        fail(await editComment(req("PATCH", `/x`, { body: "x" }), String(id), deps)).status,
      ).toBe(404);
    });
  });

  describe("delete", () => {
    it("removes a comment without replies and scrubs its text from storage", async () => {
      const path = await freshDoc();
      const id = await postId(path, "secret words");
      const res = okChange(await deleteComment(req("DELETE", `/x`), String(id), deps));
      expect(res).toMatchObject({ removed: true, comment: null, thread: null });
      const [row] = await t.db.select().from(docComments).where(eq(docComments.id, id));
      expect(row).toMatchObject({ body: "", deletedByAdmin: false });
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(row)).not.toContain("secret words");
    });

    it("keeps a deleted root with replies as a placeholder and the replies in place", async () => {
      const path = await freshDoc();
      const root = await postId(path, "original text");
      as("bob");
      const reply = await postId(path, "an answer", { parentId: root });
      as("ana");
      const res = okChange(await deleteComment(req("DELETE", `/x`), String(root), deps));
      expect(res.removed).toBe(false);
      expect(res.comment).toMatchObject({
        deleted: true,
        body: "",
        authorLabel: "",
        authorId: null,
      });
      expect(res.thread?.replies.map((r) => r.id)).toEqual([reply]);
      const [row] = await t.db.select().from(docComments).where(eq(docComments.id, root));
      expect(row?.body).toBe("");
      // Deleting the last reply makes the whole thread disappear.
      as("bob");
      const last = okChange(await deleteComment(req("DELETE", `/x`), String(reply), deps));
      expect(last).toMatchObject({ removed: true, thread: null });
    });

    it("deletes a reply and returns the thread without it", async () => {
      const path = await freshDoc();
      const root = await postId(path, "root");
      const reply = await postId(path, "reply", { parentId: root });
      const res = okChange(await deleteComment(req("DELETE", `/x`), String(reply), deps));
      expect(res.removed).toBe(true);
      expect(res.thread?.root.id).toBe(root);
      expect(res.thread?.replies).toEqual([]);
    });

    it("refuses someone else's delete with 403, admins included, and a second delete with 404", async () => {
      const path = await freshDoc();
      const id = await postId(path, "mine");
      as("bob");
      expect(fail(await deleteComment(req("DELETE", `/x`), String(id), deps)).status).toBe(403);
      as("root");
      expect(fail(await deleteComment(req("DELETE", `/x`), String(id), deps)).status).toBe(403);
      as("ana");
      okChange(await deleteComment(req("DELETE", `/x`), String(id), deps));
      expect(fail(await deleteComment(req("DELETE", `/x`), String(id), deps)).status).toBe(404);
    });
  });

  describe("resolve", () => {
    it("lets the author or any admin resolve and reopen, collapsing nothing else", async () => {
      const path = await freshDoc();
      const root = await postId(path, "root");
      const done = okChange(
        await setResolved(req("PATCH", `/x`, { resolved: true }), String(root), deps),
      );
      expect(done.thread?.root.resolvedAt).toBeInstanceOf(Date);
      as("root2");
      const reopened = okChange(
        await patchComment(req("PATCH", `/x`, { resolved: false }), String(root), deps),
      );
      expect(reopened.thread?.root.resolvedAt).toBeNull();
      const again = okChange(
        await patchComment(req("PATCH", `/x`, { resolved: true }), String(root), deps),
      );
      expect(again.thread?.root.resolvedAt).toBeInstanceOf(Date);
      const [row] = await t.db.select().from(docComments).where(eq(docComments.id, root));
      expect(row?.resolvedBy).toBe(ids.root2);
    });

    it("refuses other users with 403, replies with 400 and bad bodies with 400", async () => {
      const path = await freshDoc();
      const root = await postId(path, "root");
      const reply = await postId(path, "reply", { parentId: root });
      as("bob");
      expect(
        fail(await setResolved(req("PATCH", `/x`, { resolved: true }), String(root), deps)).status,
      ).toBe(403);
      as("ana");
      expect(
        fail(await setResolved(req("PATCH", `/x`, { resolved: true }), String(reply), deps)),
      ).toMatchObject({ status: 400, code: "not_a_thread" });
      expect(
        fail(await setResolved(req("PATCH", `/x`, { resolved: "yes" }), String(root), deps)),
      ).toMatchObject({ status: 400, field: "resolved" });
      expect(
        fail(
          await patchComment(req("PATCH", `/x`, { resolved: true, body: "x" }), String(root), deps),
        ).status,
      ).toBe(400);
    });

    it("dispatches an edit through patchComment", async () => {
      const path = await freshDoc();
      const id = await postId(path, "a");
      const res = okChange(await patchComment(req("PATCH", `/x`, { body: "b" }), String(id), deps));
      expect(res.comment?.body).toBe("b");
    });
  });

  describe("limits", () => {
    it("allows 20 comments in ten minutes and refuses the 21st with 429 and a retry time", async () => {
      const path = await freshDoc();
      as("ana");
      // ana's earlier rows plus these fill the window; use a dedicated user for a clean count.
      jar.cookie = signSession(SECRET, newSessionPayload(ids.limited!, "user", 0));
      for (let i = 0; i < RATE_LIMIT; i++) await postId(path, `c${i}`);
      const r = fail(await post(path, "one too many"));
      expect([r.status, r.code]).toEqual([429, "rate_limited"]);
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
      expect(r.retryAfterSeconds).toBeLessThanOrEqual(600);
      expect(r.error).toMatch(/minute/);
      expect(await rows(path)).toHaveLength(RATE_LIMIT);
      const res = commentResponse(r);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe(String(r.retryAfterSeconds));
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      // Comments older than the window do not count: move them out and post again.
      await t.db
        .update(docComments)
        .set({ createdAt: sql`now() - interval '11 minutes'` })
        .where(eq(docComments.authorId, ids.limited!));
      expect(ok(await post(path, "later")).status).toBe(201);
    });

    it("counts the limit per user, not per document", async () => {
      jar.cookie = signSession(SECRET, newSessionPayload(ids.bob!, "user", 0));
      await t.db.delete(docComments).where(eq(docComments.authorId, ids.bob!));
      const a = await freshDoc();
      const b = await freshDoc();
      for (let i = 0; i < RATE_LIMIT; i++) await postId(i % 2 === 0 ? a : b, `c${i}`);
      expect(fail(await post(a, "x")).status).toBe(429);
      expect(fail(await post(b, "x")).status).toBe(429);
      as("ana");
      expect(ok(await post(a, "someone else is fine")).status).toBe(201);
    });

    it("refuses with 409 once a document holds 1,000 comments, counting placeholders but not hidden deletions", async () => {
      const path = await freshDoc();
      await t.db.insert(docComments).values(
        Array.from({ length: DOCUMENT_CAP - 1 }, (_, i) => ({
          githubRepoId: 1,
          path,
          authorLabel: "seed",
          body: `seed ${i}`,
          createdAt: new Date(Date.now() - 3_600_000 - i),
        })),
      );
      // Deleted comments nobody can see do not use up room.
      await t.db.insert(docComments).values(
        Array.from({ length: 5 }, () => ({
          githubRepoId: 1,
          path,
          authorLabel: "gone",
          body: "",
          deletedAt: new Date(),
          createdAt: new Date(Date.now() - 3_600_000),
        })),
      );
      jar.cookie = signSession(SECRET, newSessionPayload(ids.capper!, "user", 0));
      expect(ok(await post(path, "the 1000th")).status).toBe(201);
      const r = fail(await post(path, "the 1001st"));
      expect([r.status, r.code]).toEqual([409, "document_full"]);
      expect(r.error).toMatch(/1,000/);
      const [count] = await t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(docComments)
        .where(eq(docComments.path, path));
      expect(count?.n).toBe(DOCUMENT_CAP + 5);
    });

    it("never exceeds the cap when posts race (advisory lock per document)", async () => {
      const path = await freshDoc();
      await t.db.insert(docComments).values(
        Array.from({ length: DOCUMENT_CAP - 3 }, (_, i) => ({
          githubRepoId: 1,
          path,
          authorLabel: "seed",
          body: `seed ${i}`,
          createdAt: new Date(Date.now() - 3_600_000 - i),
        })),
      );
      const racers = [0, 1, 2, 3, 4, 5].map((i) => ids[`racer${i}`]!);
      const results = await Promise.all(
        racers.map((id) =>
          createComment(
            req("POST", "/api/comments", { repo: "acme/handbook", path, body: "race" }),
            {
              ...deps,
              user: async (): Promise<CurrentUser> => ({
                id,
                email: `racer${id}@example.com`,
                role: "user",
              }),
            },
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      const refused = results.filter((r) => !r.ok).map((r) => fail(r).status);
      expect(refused).toEqual([409, 409, 409]);
      expect(await rows(path)).toHaveLength(DOCUMENT_CAP);
    });
  });

  describe("moderation", () => {
    it("lets an admin delete someone else's comment with replies, leaving a placeholder", async () => {
      const path = await freshDoc();
      const root = await postId(path, "rude words");
      as("bob");
      await postId(path, "a reply", { parentId: root });
      as("root");
      const res = okChange(await adminDelete(req("DELETE", `/x`), String(root), deps));
      expect(res.removed).toBe(false);
      expect(res.comment).toMatchObject({ deleted: true, body: "", authorLabel: "" });
      const [row] = await t.db.select().from(docComments).where(eq(docComments.id, root));
      expect(row).toMatchObject({ body: "", deletedByAdmin: true });
      // The public view never says who deleted it.
      expect(JSON.stringify(res)).not.toMatch(/deletedByAdmin|deleted_by_admin/);
    });

    it("also deletes comments in blocked repositories and of missing documents", async () => {
      const [blocked] = await t.db
        .insert(docComments)
        .values({ githubRepoId: 2, path: "docs/s.md", authorLabel: "x", body: "hidden" })
        .returning({ id: docComments.id });
      const [orphan] = await t.db
        .insert(docComments)
        .values({ githubRepoId: 999, path: "docs/gone.md", authorLabel: "x", body: "orphan" })
        .returning({ id: docComments.id });
      as("root");
      okChange(await adminDelete(req("DELETE", `/x`), String(blocked!.id), deps));
      okChange(await adminDelete(req("DELETE", `/x`), String(orphan!.id), deps));
      const left = await t.db.select().from(docComments).where(eq(docComments.id, orphan!.id));
      expect(left[0]).toMatchObject({ body: "", deletedByAdmin: true });
      expect(fail(await adminDelete(req("DELETE", `/x`), String(orphan!.id), deps)).status).toBe(
        404,
      );
    });

    it("answers 401 and 403 and works while comments are off", async () => {
      const path = await freshDoc();
      const id = await postId(path, "x");
      as(null);
      expect(fail(await adminDelete(req("DELETE", `/x`), String(id), deps)).status).toBe(401);
      expect(fail(await adminPurge(req("POST", `/x`, { ids: [id] }), deps)).status).toBe(401);
      as("ana");
      expect(fail(await adminDelete(req("DELETE", `/x`), String(id), deps)).status).toBe(403);
      expect(fail(await adminPurge(req("POST", `/x`, { ids: [id] }), deps)).status).toBe(403);
      as("root");
      enabled = false;
      okChange(await adminDelete(req("DELETE", `/x`), String(id), deps));
      expect(fail(await adminDelete(req("DELETE", `/x`), "abc", deps)).status).toBe(404);
      expect(
        fail(
          await adminDelete(
            req("DELETE", `/x`, undefined, { Origin: "https://evil.example.net" }),
            String(id),
            deps,
          ),
        ).status,
      ).toBe(403);
    });

    it("permanently removes deleted and orphaned comments and reports the count", async () => {
      const path = await freshDoc();
      const live = await postId(path, "keep me");
      const gone = await postId(path, "delete me");
      okChange(await deleteComment(req("DELETE", `/x`), String(gone), deps));
      as("root");
      const refused = fail(await adminPurge(req("POST", `/x`, { ids: [live, gone] }), deps));
      expect([refused.status, refused.code, refused.refused]).toEqual([409, "not_purgeable", 1]);
      expect(await rows(path)).toHaveLength(2);
      const removed = ok(await adminPurge(req("POST", `/x`, { ids: [gone] }), deps));
      expect(removed).toMatchObject({ status: 200, removed: 1 });
      expect((await rows(path)).map((r) => r.id)).toEqual([live]);
      expect(commentResponse(removed).status).toBe(200);
    });

    it("removes all comments of a missing document in one action, replies included", async () => {
      const rootRow = await t.db
        .insert(docComments)
        .values({ githubRepoId: 1, path: "docs/removed.md", authorLabel: "a", body: "r" })
        .returning({ id: docComments.id });
      await t.db.insert(docComments).values([
        {
          githubRepoId: 1,
          path: "docs/removed.md",
          authorLabel: "a",
          body: "1",
          parentId: rootRow[0]!.id,
        },
        {
          githubRepoId: 1,
          path: "docs/removed.md",
          authorLabel: "a",
          body: "2",
          parentId: rootRow[0]!.id,
        },
      ]);
      as("root");
      const res = ok(
        await adminPurge(req("POST", `/x`, { githubRepoId: 1, path: "docs/removed.md" }), deps),
      );
      expect(res).toMatchObject({ removed: 3 });
      expect(await rows("docs/removed.md")).toEqual([]);
      expect(
        fail(
          await adminPurge(req("POST", `/x`, { githubRepoId: 1, path: "docs/removed.md" }), deps),
        ).status,
      ).toBe(404);
    });

    it("refuses to purge a whole existing document with live comments, and a deleted root with live replies", async () => {
      const path = await freshDoc();
      const root = await postId(path, "root");
      await postId(path, "reply", { parentId: root });
      okChange(await deleteComment(req("DELETE", `/x`), String(root), deps));
      as("root");
      expect(fail(await adminPurge(req("POST", `/x`, { ids: [root] }), deps)).status).toBe(409);
      expect(
        fail(await adminPurge(req("POST", `/x`, { githubRepoId: 1, path }), deps)).status,
      ).toBe(409);
      expect(await rows(path)).toHaveLength(2);
    });

    it("validates the purge body", async () => {
      as("root");
      for (const body of [
        {},
        { ids: [] },
        { ids: ["1"] },
        { ids: [1], path: "x" },
        { githubRepoId: 1 },
        { ids: Array.from({ length: 501 }, (_, i) => i + 1) },
      ]) {
        expect(fail(await adminPurge(req("POST", `/x`, body), deps)).status).toBe(400);
      }
    });
  });

  describe("logs", () => {
    it("carry ids and outcomes and never comment text, emails or request bodies", async () => {
      const path = await freshDoc();
      const marker = "ZEBRA-MARKER-4711";
      const root = await postId(path, `${marker} one`);
      as("bob");
      await postId(path, `${marker} two`, { parentId: root });
      as("ana");
      okChange(
        await editComment(req("PATCH", `/x`, { body: `${marker} edited` }), String(root), deps),
      );
      fail(await post(path, "   "));
      fail(await post(path, `${marker}`, { asOrganization: true }));
      okChange(await setResolved(req("PATCH", `/x`, { resolved: true }), String(root), deps));
      okChange(await deleteComment(req("DELETE", `/x`), String(root), deps));
      as("root");
      const [other] = await t.db
        .insert(docComments)
        .values({ githubRepoId: 1, path, authorLabel: "x", body: `${marker} other` })
        .returning({ id: docComments.id });
      okChange(await adminDelete(req("DELETE", `/x`), String(other!.id), deps));
      ok(await adminPurge(req("POST", `/x`, { ids: [other!.id] }), deps));

      const all = rec.lines.join("");
      expect(all).not.toContain(marker);
      expect(all).not.toMatch(/example\.com/);
      const events = rec.events();
      for (const e of ["create", "edit", "resolve", "delete", "admin_delete", "admin_purge"]) {
        expect(events, e).toContain(`comments.${e}`);
      }
      const created = rec.find("comments.create")[0]!;
      expect(created).toMatchObject({
        userId: ids.ana,
        commentId: root,
        outcome: "ok",
        action: "create",
        githubRepoId: 1,
      });
      const refused = rec.find("comments.create").filter((r) => r.outcome === "refused");
      expect(refused.map((r) => r.status)).toEqual([400, 403]);
      const adminLine = rec.find("comments.admin_delete")[0]!;
      expect(adminLine).toMatchObject({ userId: ids.root, commentId: other!.id });
      expect(adminLine.ts).toBeDefined();
      expect(rec.find("comments.admin_purge")[0]).toMatchObject({ userId: ids.root, count: 1 });
    });
  });

  describe("responses", () => {
    it("serializes a change with the comment and thread, and failures with a fixed body", async () => {
      const path = await freshDoc();
      const res = commentResponse(await post(path, "hello"));
      expect(res.status).toBe(201);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const json = (await res.json()) as {
        comment: { body: string };
        thread: unknown;
        removed: boolean;
        ok?: unknown;
      };
      expect(json.comment.body).toBe("hello");
      expect(json.thread).toBeTruthy();
      expect(json.removed).toBe(false);
      expect(json).not.toHaveProperty("ok");
      const bad = commentResponse(await post(path, " "));
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({
        error: "The comment is empty",
        code: "invalid",
        field: "body",
      });
    });
  });
});
