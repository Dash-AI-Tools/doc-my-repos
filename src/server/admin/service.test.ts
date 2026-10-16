import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { hashPassword } from "../auth/password";
import { newSessionPayload, SESSION_COOKIE, signSession } from "../auth/session";
import {
  handleCreateUser,
  handleListRepos,
  handleListUsers,
  handleReorderStarred,
  handleUpdateRepo,
  handleUpdateUser,
} from "./service";
import {
  handleGetSettings,
  handleSaveProviderCredentials,
  handleSaveSettings,
  handleTestGithub,
} from "./settings";

const SECRET = "admin-service-test-secret-0123456789";

// Cookie jar for the next/headers mock below: tests sign in by setting it.
const jar = vi.hoisted(() => ({ cookie: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined,
  }),
}));

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describeDb("admin routes", () => {
  let t: TestDatabase;
  let adminId = 0;
  let viewerId = 0;

  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    t = await createTestDatabase();
    const rows = await t.db
      .insert(users)
      .values([
        {
          email: "admin@example.com",
          passwordHash: await hashPassword("admin-pass-1234"),
          role: "admin",
        },
        {
          email: "viewer@example.com",
          passwordHash: await hashPassword("viewer-pass-1234"),
          role: "user",
        },
      ])
      .returning({ id: users.id });
    adminId = rows[0]?.id ?? 0;
    viewerId = rows[1]?.id ?? 0;
    await t.db.insert(repos).values({
      githubId: 1,
      owner: "acme",
      name: "handbook",
      defaultBranch: "main",
      visibility: "public",
      htmlUrl: "https://github.com/acme/handbook",
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await t?.drop();
  }, 60_000);

  function signInAs(role: "admin" | "user", uid?: number, pwv = 0) {
    const id = uid ?? (role === "admin" ? adminId : viewerId);
    jar.cookie = signSession(SECRET, newSessionPayload(id, role, pwv));
  }

  it("401s without a session and 403s for viewers on every admin route", async () => {
    jar.cookie = "";
    for (const call of [
      () => handleListUsers(t.db),
      () => handleCreateUser(jsonRequest("/api/admin/users", "POST", {}), t.db),
      () => handleUpdateUser(adminId, jsonRequest("/x", "PATCH", {}), t.db),
      () => handleListRepos(t.db),
      () => handleUpdateRepo(jsonRequest("/api/admin/repos", "PATCH", {}), t.db),
      () => handleReorderStarred(jsonRequest("/api/admin/repos/starred", "PUT", {}), t.db),
      () => handleGetSettings({ db: t.db }),
      () => handleSaveSettings(jsonRequest("/api/admin/settings", "PUT", {}), { db: t.db }),
      () => handleTestGithub(jsonRequest("/api/admin/settings/test", "POST", {}), { db: t.db }),
      () =>
        handleSaveProviderCredentials(jsonRequest("/api/admin/ask/credentials", "PUT", {}), {
          db: t.db,
        }),
    ]) {
      expect((await call()).status).toBe(401);
    }
    signInAs("user");
    for (const call of [
      () => handleListUsers(t.db),
      () => handleCreateUser(jsonRequest("/api/admin/users", "POST", {}), t.db),
      () => handleUpdateUser(adminId, jsonRequest("/x", "PATCH", {}), t.db),
      () => handleListRepos(t.db),
      () => handleUpdateRepo(jsonRequest("/api/admin/repos", "PATCH", {}), t.db),
      () => handleReorderStarred(jsonRequest("/api/admin/repos/starred", "PUT", {}), t.db),
      () => handleGetSettings({ db: t.db }),
      () => handleSaveSettings(jsonRequest("/api/admin/settings", "PUT", {}), { db: t.db }),
      () => handleTestGithub(jsonRequest("/api/admin/settings/test", "POST", {}), { db: t.db }),
      () =>
        handleSaveProviderCredentials(jsonRequest("/api/admin/ask/credentials", "PUT", {}), {
          db: t.db,
        }),
    ]) {
      expect((await call()).status).toBe(403);
    }
  });

  it("lists, creates, and updates users as admin", async () => {
    signInAs("admin");
    expect(await (await handleListUsers(t.db)).json()).toMatchObject({
      users: [
        { email: "admin@example.com", role: "admin" },
        { email: "viewer@example.com", role: "user" },
      ],
    });

    const created = await handleCreateUser(
      jsonRequest("/api/admin/users", "POST", {
        email: "new@example.com",
        password: "new-pass-123456",
        role: "user",
      }),
      t.db,
    );
    expect(created.status).toBe(201);

    const duplicate = await handleCreateUser(
      jsonRequest("/api/admin/users", "POST", {
        email: "new@example.com",
        password: "new-pass-123456",
        role: "user",
      }),
      t.db,
    );
    expect(duplicate.status).toBe(409);

    const list = (await (await handleListUsers(t.db)).json()) as {
      users: { id: number; email: string }[];
    };
    const target = list.users.find((u) => u.email === "new@example.com");
    expect(target).toBeDefined();
    const disabled = await handleUpdateUser(
      target!.id,
      jsonRequest("/x", "PATCH", { disabled: true }),
      t.db,
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ user: { disabled: true } });
  });

  it("toggles repo access as admin and lists blocked repos", async () => {
    signInAs("admin");
    const blocked = await handleUpdateRepo(
      jsonRequest("/api/admin/repos", "PATCH", {
        owner: "acme",
        name: "handbook",
        isAllowed: false,
      }),
      t.db,
    );
    expect(blocked.status).toBe(200);
    const list = (await (await handleListRepos(t.db)).json()) as {
      repos: { name: string; isAllowed: boolean }[];
    };
    expect(list.repos).toMatchObject([{ name: "handbook", isAllowed: false }]);
    const missing = await handleUpdateRepo(
      jsonRequest("/api/admin/repos", "PATCH", { owner: "acme", name: "nope", isAllowed: false }),
      t.db,
    );
    expect(missing.status).toBe(404);
  });

  it("stars, unstars and reorders repos as admin, with 400 and 409 and nothing written on failure", async () => {
    await t.db.insert(repos).values(
      ["alpha", "beta"].map((name, i) => ({
        githubId: 50 + i,
        owner: "acme",
        name,
        defaultBranch: "main",
        visibility: "public" as const,
        htmlUrl: `https://github.com/acme/${name}`,
      })),
    );
    signInAs("admin");
    const patch = (body: unknown) =>
      handleUpdateRepo(jsonRequest("/api/admin/repos", "PATCH", body), t.db);
    const put = (body: unknown) =>
      handleReorderStarred(jsonRequest("/api/admin/repos/starred", "PUT", body), t.db);
    const starred = async () =>
      (
        (await (await handleListRepos(t.db)).json()) as {
          repos: { name: string; isStarred: boolean; starPosition: number | null }[];
        }
      ).repos
        .filter((r) => r.isStarred)
        .sort((a, b) => (a.starPosition ?? 0) - (b.starPosition ?? 0))
        .map((r) => r.name);

    // Neither field, or a non-boolean, is a 400; isAllowed-only keeps working.
    expect((await patch({ owner: "acme", name: "alpha" })).status).toBe(400);
    expect((await patch({ owner: "acme", name: "alpha", isStarred: "yes" })).status).toBe(400);
    expect(
      (await patch({ owner: "acme", name: "alpha", isStarred: true, isAllowed: 1 })).status,
    ).toBe(400);
    expect(await starred()).toEqual([]);
    const both = await patch({ owner: "ACME", name: "alpha", isStarred: true, isAllowed: false });
    expect(both.status).toBe(200);
    expect(await both.json()).toMatchObject({
      repo: { owner: "acme", name: "alpha", isStarred: true, isAllowed: false, starPosition: 0 },
    });
    expect((await patch({ owner: "acme", name: "beta", isStarred: true })).status).toBe(200);
    expect((await patch({ owner: "acme", name: "handbook", isStarred: true })).status).toBe(200);
    expect(await starred()).toEqual(["alpha", "beta", "handbook"]);

    // Reorder: valid (blocked alpha included), then stale, malformed and unknown.
    const ok = await put({
      repos: [
        { owner: "acme", name: "handbook" },
        { owner: "ACME", name: "ALPHA" },
        { owner: "acme", name: "beta" },
      ],
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      repos: [
        { owner: "acme", name: "handbook" },
        { owner: "acme", name: "alpha" },
        { owner: "acme", name: "beta" },
      ],
    });
    expect(await starred()).toEqual(["handbook", "alpha", "beta"]);
    const before = await starred();
    const entry = (name: string) => ({ owner: "acme", name });
    for (const [body, status] of [
      [{ repos: [entry("handbook"), entry("alpha")] }, 409],
      [{ repos: [entry("handbook"), entry("alpha"), entry("beta"), entry("handbook")] }, 400],
      [{ repos: [entry("handbook"), entry("alpha"), entry("nope")] }, 400],
      [{ repos: [entry("handbook"), entry("alpha"), "beta"] }, 400],
      [{ repos: "nope" }, 400],
      [{}, 400],
    ] as const) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(status);
      expect(await starred()).toEqual(before);
    }

    // Unstar in the middle keeps the relative order; star again goes last.
    expect((await patch({ owner: "acme", name: "alpha", isStarred: false })).status).toBe(200);
    expect(await starred()).toEqual(["handbook", "beta"]);
    expect((await patch({ owner: "acme", name: "alpha", isStarred: true })).status).toBe(200);
    expect(await starred()).toEqual(["handbook", "beta", "alpha"]);
    // A viewer cannot do either.
    signInAs("user");
    expect((await patch({ owner: "acme", name: "beta", isStarred: false })).status).toBe(403);
    expect((await put({ repos: [] })).status).toBe(403);
    signInAs("admin");
    expect(await starred()).toEqual(["handbook", "beta", "alpha"]);
  });
});
