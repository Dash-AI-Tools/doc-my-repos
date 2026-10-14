import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { hashPassword } from "../auth/password";
import { newSessionPayload, SESSION_COOKIE, signSession } from "../auth/session";
import {
  handleCreateUser,
  handleGithubConfig,
  handleListRepos,
  handleListUsers,
  handleSetRepoAllowed,
  handleUpdateUser,
} from "./service";

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

  function stubFullEnv() {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    vi.stubEnv("DATABASE_URL", "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos");
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "67890");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", "");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret-0123");
    vi.stubEnv("SYNC_SECRET", "sync-secret-0123456");
  }

  it("401s without a session and 403s for viewers on every admin route", async () => {
    jar.cookie = "";
    for (const call of [
      () => handleListUsers(t.db),
      () => handleCreateUser(jsonRequest("/api/admin/users", "POST", {}), t.db),
      () => handleUpdateUser(adminId, jsonRequest("/x", "PATCH", {}), t.db),
      () => handleListRepos(t.db),
      () => handleSetRepoAllowed(jsonRequest("/api/admin/repos", "PATCH", {}), t.db),
      () => handleGithubConfig(),
    ]) {
      expect((await call()).status).toBe(401);
    }
    signInAs("user");
    for (const call of [
      () => handleListUsers(t.db),
      () => handleCreateUser(jsonRequest("/api/admin/users", "POST", {}), t.db),
      () => handleUpdateUser(adminId, jsonRequest("/x", "PATCH", {}), t.db),
      () => handleListRepos(t.db),
      () => handleSetRepoAllowed(jsonRequest("/api/admin/repos", "PATCH", {}), t.db),
      () => handleGithubConfig(t.db),
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
    const blocked = await handleSetRepoAllowed(
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
    const missing = await handleSetRepoAllowed(
      jsonRequest("/api/admin/repos", "PATCH", { owner: "acme", name: "nope", isAllowed: false }),
      t.db,
    );
    expect(missing.status).toBe(404);
  });

  it("shows the GitHub config summary without secrets", async () => {
    stubFullEnv();
    signInAs("admin");
    const response = await handleGithubConfig(t.db);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE KEY");
    expect(JSON.parse(text)).toHaveProperty("config");
  });
});
