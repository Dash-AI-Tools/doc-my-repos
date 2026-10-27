import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { newSessionPayload, SESSION_COOKIE, signSession } from "../auth/session";
import { docComments, documents, repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { handleAdminListComments, handleListComments, parseDocCommentsQuery } from "./read-api";
import type { CommentDeps } from "./service";

const SECRET = "comments-read-api-test-secret-0123456789";

const jar = vi.hoisted(() => ({ cookie: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined,
  }),
}));

const get = (url: string) => new Request(`http://localhost${url}`);

describe("parseDocCommentsQuery", () => {
  const parse = (q: string) => parseDocCommentsQuery(new URLSearchParams(q));
  it("reads repo, path and cursor", () => {
    expect(parse("repo=acme/handbook&path=docs/a.md")).toEqual({
      repo: { owner: "acme", name: "handbook" },
      path: "docs/a.md",
      cursor: null,
    });
  });
  it.each([
    ["", "repo"],
    ["repo=acme&path=a.md", "repo"],
    ["repo=a/b/c&path=a.md", "repo"],
    ["repo=a/b&repo=c/d&path=a.md", "repo"],
    ["repo=a/b", "path"],
    ["repo=a/b&path=", "path"],
    ["repo=a/b&path=a.md&cursor=nope", "cursor"],
  ])("rejects %s naming %s", (q, field) => {
    expect(parse(q)).toMatchObject({ ok: false, status: 400, field });
  });
});

describeDb("comment read handlers", () => {
  let t: TestDatabase;
  const ids: Record<string, number> = {};
  let enabled = true;
  let deps: CommentDeps;

  const as = (name: string | null) => {
    jar.cookie =
      name === null
        ? ""
        : signSession(SECRET, newSessionPayload(ids[name]!, name === "root" ? "admin" : "user", 0));
  };

  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    t = await createTestDatabase();
    const made = await t.db
      .insert(users)
      .values([
        { email: "ana@example.com", passwordHash: "x", role: "user" as const },
        { email: "root@example.com", passwordHash: "x", role: "admin" as const },
      ])
      .returning({ id: users.id, email: users.email });
    for (const u of made) ids[u.email.split("@")[0]!] = u.id;
    const mk = async (githubId: number, name: string, isAllowed: boolean) => {
      const [r] = await t.db
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
      await t.db.insert(documents).values({
        repoId: r!.id,
        path: "docs/a.md",
        title: "a",
        blobSha: "a",
        sizeBytes: 1,
        body: "x",
      });
    };
    await mk(1, "handbook", true);
    await mk(2, "secret", false);
    const base = { githubRepoId: 1, path: "docs/a.md", authorId: ids.ana, authorLabel: "ana" };
    for (let i = 0; i < 3; i++) {
      await t.db.insert(docComments).values({ ...base, body: `c${i}` });
    }
    await t.db
      .insert(docComments)
      .values({ githubRepoId: 2, path: "docs/a.md", authorLabel: "ana", body: "hidden" });
    await t.db
      .insert(docComments)
      .values({ githubRepoId: 1, path: "docs/gone.md", authorLabel: "ana", body: "orphan" });
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await t?.drop();
  }, 60_000);
  beforeEach(() => {
    enabled = true;
    deps = { db: t.db, enabled: () => enabled };
    as("ana");
  });

  describe("GET /api/comments", () => {
    it("answers 404 when comments are off, even signed out", async () => {
      enabled = false;
      as(null);
      const res = await handleListComments(
        get("/api/comments?repo=acme/handbook&path=docs/a.md"),
        deps,
      );
      expect(res.status).toBe(404);
    });

    it("answers 401 without a session", async () => {
      as(null);
      const res = await handleListComments(
        get("/api/comments?repo=acme/handbook&path=docs/a.md"),
        deps,
      );
      expect([res.status, (await res.json()).code]).toEqual([401, "unauthorized"]);
    });

    it("lists threads with no-store and no email for a reader", async () => {
      const res = await handleListComments(
        get("/api/comments?repo=acme/handbook&path=docs/a.md"),
        deps,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.threads.map((th: { root: { body: string } }) => th.root.body)).toEqual([
        "c0",
        "c1",
        "c2",
      ]);
      expect(body.nextCursor).toBeNull();
      expect(JSON.stringify(body)).not.toContain("ana@example.com");
    });

    it("shows emails to an admin", async () => {
      as("root");
      const res = await handleListComments(
        get("/api/comments?repo=acme/handbook&path=docs/a.md"),
        deps,
      );
      expect((await res.json()).threads[0].root.authorEmail).toBe("ana@example.com");
    });

    it("answers 400 for bad parameters naming the field", async () => {
      for (const [q, field] of [
        ["path=docs/a.md", "repo"],
        ["repo=acme/handbook", "path"],
        ["repo=acme/handbook&path=docs/a.md&cursor=zzz", "cursor"],
      ] as const) {
        const res = await handleListComments(get(`/api/comments?${q}`), deps);
        expect([res.status, (await res.json()).field]).toEqual([400, field]);
      }
    });

    it("answers 404 for a missing document, an unknown repo, an orphan and a hidden repository", async () => {
      for (const q of [
        "repo=acme/handbook&path=docs/none.md",
        "repo=acme/handbook&path=docs/gone.md",
        "repo=acme/nope&path=docs/a.md",
        "repo=acme/secret&path=docs/a.md",
      ]) {
        as("root");
        const res = await handleListComments(get(`/api/comments?${q}`), deps);
        expect([q, res.status]).toEqual([q, 404]);
      }
    });
  });

  describe("GET /api/admin/comments", () => {
    it("answers 401 and 403", async () => {
      as(null);
      expect((await handleAdminListComments(get("/api/admin/comments"), deps)).status).toBe(401);
      as("ana");
      expect((await handleAdminListComments(get("/api/admin/comments"), deps)).status).toBe(403);
    });

    it("lists everything, orphans and blocked included, newest first, while comments are off", async () => {
      as("root");
      enabled = false;
      const res = await handleAdminListComments(get("/api/admin/comments"), deps);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.items.map((i: { body: string }) => i.body)).toEqual([
        "orphan",
        "hidden",
        "c2",
        "c1",
        "c0",
      ]);
      expect(body.items[4].authorEmail).toBe("ana@example.com");
    });

    it("filters by state and repository and pages with a cursor", async () => {
      as("root");
      const states = async (q: string) =>
        (
          await (await handleAdminListComments(get(`/api/admin/comments?${q}`), deps)).json()
        ).items.map((i: { state: string }) => i.state);
      expect(await states("state=orphaned")).toEqual(["orphaned"]);
      expect(await states("state=blocked")).toEqual(["blocked"]);
      expect(await states("githubRepoId=1&state=live")).toEqual(["live", "live", "live"]);
      const first = await (
        await handleAdminListComments(get("/api/admin/comments?limit=2"), deps)
      ).json();
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const next = await (
        await handleAdminListComments(
          get(`/api/admin/comments?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`),
          deps,
        )
      ).json();
      expect(next.items.map((i: { body: string }) => i.body)).toEqual(["c2", "c1"]);
    });

    it("answers 400 for bad filters", async () => {
      as("root");
      for (const [q, field] of [
        ["state=weird", "state"],
        ["githubRepoId=abc", "githubRepoId"],
        ["cursor=x", "cursor"],
        ["limit=-1", "limit"],
      ] as const) {
        const res = await handleAdminListComments(get(`/api/admin/comments?${q}`), deps);
        expect([res.status, (await res.json()).field]).toEqual([400, field]);
      }
    });
  });
});
