import { generateKeyPairSync, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, type DbHandle } from "./db/client";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { ENCRYPTION_KEY_VAR, parseEncryptionKey } from "./settings/crypto";
import { readVersion, saveWorkspace } from "./settings/store";
import {
  NotConfiguredError,
  createWorkspace,
  getWorkspace,
  invalidateWorkspace,
  requireGitHub,
} from "./workspace";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEY = parseEncryptionKey(ENCRYPTION_KEY).key;
const ENV = { [ENCRYPTION_KEY_VAR]: ENCRYPTION_KEY };
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const WEBHOOK = "webhook-secret-0123456789";

describeDb("the workspace", () => {
  let testDb: TestDatabase;
  let h: DbHandle;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    h = createDb(testDb.url.reveal(), { max: 5 });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });
  beforeEach(async () => {
    await h.pool.query(
      "TRUNCATE workspace_settings, workspace_secrets, settings_audit RESTART IDENTITY",
    );
    invalidateWorkspace();
  });
  afterEach(() => invalidateWorkspace());

  async function save(change: { settings?: unknown; secrets?: Record<string, string | null> }) {
    const result = await saveWorkspace(h.db, KEY, {
      userId: null,
      expectedVersion: await readVersion(h.db),
      ...change,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }
  const complete = {
    settings: { github: { appId: 1, installationId: 2 }, repos: ["api"] },
    secrets: { github_private_key: PEM, github_webhook_secret: WEBHOOK },
  };

  it("is a normal, safe state when nothing is configured", async () => {
    const ws = await createWorkspace({ handle: h, env: ENV });
    expect(ws.github).toBeNull();
    expect(ws.webhookSecret).toBeNull();
    expect(ws.problems.missingGithub).toEqual([
      "github.appId",
      "github.installationId",
      "github_private_key",
    ]);
    expect(ws.config.comments.enabled).toBe(true);
    expect(() => requireGitHub(ws)).toThrow(NotConfiguredError);
    try {
      requireGitHub(ws);
    } catch (error) {
      expect((error as NotConfiguredError).missing).toEqual(ws.problems.missingGithub);
      expect(String(error)).not.toContain(PEM.slice(30, 60));
    }
  });

  it("builds the GitHub parts once App id, installation id and key are all saved", async () => {
    await save({ settings: { github: { appId: 1, installationId: 2 } } });
    expect((await createWorkspace({ handle: h, env: ENV })).problems.missingGithub).toEqual([
      "github_private_key",
    ]);
    await save({ settings: complete.settings, secrets: complete.secrets });
    const ws = await createWorkspace({ handle: h, env: ENV });
    expect(ws.problems.missingGithub).toEqual([]);
    expect(ws.github?.installationId).toBe(2);
    expect(ws.github?.sync.config.repos).toEqual(["api"]);
    expect(ws.webhookSecret?.reveal()).toBe(WEBHOOK);
  });

  it("keeps secrets out of anything printed, serialized or inspected", async () => {
    await save(complete);
    const ws = await createWorkspace({ handle: h, env: ENV });
    for (const text of [String(ws), JSON.stringify(ws), JSON.stringify({ ws })]) {
      expect(text).not.toContain(WEBHOOK);
      expect(text).not.toContain("PRIVATE KEY");
    }
  });

  it("treats a missing or invalid encryption key as unreadable secrets, not as a crash", async () => {
    await save(complete);
    for (const env of [{}, { [ENCRYPTION_KEY_VAR]: "short" }]) {
      const ws = await createWorkspace({ handle: h, env });
      expect(ws.github).toBeNull();
      expect(ws.webhookSecret).toBeNull();
      expect(ws.problems.encryptionKey).toMatch(/^SETTINGS_ENCRYPTION_KEY: /);
      expect(ws.config.github.appId).toBe(1);
    }
  });

  it("reports secrets that cannot be decrypted with the current key, by name", async () => {
    await save(complete);
    const other = randomBytes(32).toString("base64");
    const ws = await createWorkspace({ handle: h, env: { [ENCRYPTION_KEY_VAR]: other } });
    expect(ws.github).toBeNull();
    expect([...ws.problems.unreadable].sort()).toEqual([
      "github_private_key",
      "github_webhook_secret",
    ]);
    expect(ws.problems.encryptionKey).toBeNull();
  });

  it("falls back to defaults and says so when the stored settings are invalid", async () => {
    await h.pool.query(
      `INSERT INTO workspace_settings (id, data, version) VALUES (1, '{"limits":{"maxFileBytes":1}}', 3)`,
    );
    const ws = await createWorkspace({ handle: h, env: ENV });
    expect(ws.problems.invalidStored).toBe(true);
    expect(ws.config.limits.maxFileBytes).toBe(262144);
  });

  describe("getWorkspace", () => {
    it("reuses the built workspace while the settings version is unchanged", async () => {
      await save(complete);
      const first = await getWorkspace({ handle: h, env: ENV });
      expect(await getWorkspace({ handle: h, env: ENV })).toBe(first);
      // Even after the re-check interval, an unchanged version keeps the same workspace.
      expect(await getWorkspace({ handle: h, env: ENV, recheckMs: 0 })).toBe(first);
      expect(await getWorkspace({ handle: h, env: ENV, fresh: true })).toBe(first);
    });

    it("shares one build between concurrent callers", async () => {
      await save(complete);
      const [a, b, c] = await Promise.all([
        getWorkspace({ handle: h, env: ENV }),
        getWorkspace({ handle: h, env: ENV }),
        getWorkspace({ handle: h, env: ENV }),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it("a save in this process shows on the next call after invalidating", async () => {
      await save(complete);
      const before = await getWorkspace({ handle: h, env: ENV });
      expect(before.config.sync.intervalMinutes).toBe(60);
      await save({ settings: { ...complete.settings, sync: { intervalMinutes: 30 } } });
      invalidateWorkspace();
      const after = await getWorkspace({ handle: h, env: ENV });
      expect(after).not.toBe(before);
      expect(after.config.sync.intervalMinutes).toBe(30);
    });

    it("another instance's change is seen after the re-check interval, not before", async () => {
      await save(complete);
      const before = await getWorkspace({ handle: h, env: ENV });
      // A change made elsewhere: no local invalidation.
      await save({ settings: { ...complete.settings, repos: ["api", "web"] } });
      expect(await getWorkspace({ handle: h, env: ENV })).toBe(before);
      const after = await getWorkspace({ handle: h, env: ENV, recheckMs: 0 });
      expect(after).not.toBe(before);
      expect(after.config.repos).toEqual(["api", "web"]);
    });

    it("a replaced secret is used by the next workspace and not by the one in progress", async () => {
      await save(complete);
      const inProgress = await getWorkspace({ handle: h, env: ENV });
      await save({ secrets: { github_webhook_secret: "another-webhook-secret-9876" } });
      const next = await getWorkspace({ handle: h, env: ENV, fresh: true });
      expect(inProgress.webhookSecret?.reveal()).toBe(WEBHOOK);
      expect(next.webhookSecret?.reveal()).toBe("another-webhook-secret-9876");
      expect(inProgress.config).not.toBe(next.config);
    });

    it("keeps serving the cached workspace when the database cannot be reached", async () => {
      await save(complete);
      const cached = await getWorkspace({ handle: h, env: ENV });
      const dead = createDb("postgres://app:pw@127.0.0.1:1/none", { connectTimeoutMs: 500 });
      try {
        expect(await getWorkspace({ handle: dead, env: ENV, fresh: true })).toBe(cached);
      } finally {
        await dead.close();
      }
    });

    it("does not cache a failed build", async () => {
      const dead = createDb("postgres://app:pw@127.0.0.1:1/none", { connectTimeoutMs: 500 });
      try {
        await expect(getWorkspace({ handle: dead, env: ENV })).rejects.toBeDefined();
      } finally {
        await dead.close();
      }
      await save(complete);
      expect((await getWorkspace({ handle: h, env: ENV })).github).not.toBeNull();
    });

    it("reads the MCP switch from the saved settings, on by default, without a restart", async () => {
      expect((await getWorkspace({ handle: h, env: ENV })).config.mcp.enabled).toBe(true);
      // A save in this process drops the cached workspace (the settings API does the same).
      await save({ settings: { mcp: { enabled: false } } });
      invalidateWorkspace();
      expect((await getWorkspace({ handle: h, env: ENV })).config.mcp.enabled).toBe(false);
      await save({ settings: { mcp: { enabled: true } } });
      invalidateWorkspace();
      expect((await getWorkspace({ handle: h, env: ENV })).config.mcp.enabled).toBe(true);
    });

    it("reads the comments switch from the saved settings", async () => {
      await save({ settings: { comments: { enabled: false } } });
      expect((await getWorkspace({ handle: h, env: ENV })).config.comments.enabled).toBe(false);
    });
  });
});

describeDb("the workspace of each tenant", () => {
  let dbA: TestDatabase;
  let dbB: TestDatabase;
  let a: DbHandle;
  let b: DbHandle;

  beforeAll(async () => {
    [dbA, dbB] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    a = createDb(dbA.url.reveal(), { max: 3 });
    b = createDb(dbB.url.reveal(), { max: 3 });
  }, 60_000);
  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
    await Promise.all([dbA?.drop(), dbB?.drop()]);
  });
  afterEach(() => {
    invalidateWorkspace("tenant-a");
    invalidateWorkspace("tenant-b");
  });

  async function saveScope(handle: DbHandle, repos: string[]) {
    const result = await saveWorkspace(handle.db, KEY, {
      userId: null,
      expectedVersion: await readVersion(handle.db),
      settings: { repos },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }
  const workspaceOf = (tenantId: string, handle: DbHandle, fresh = false) =>
    getWorkspace({ tenantId, handle, env: ENV, fresh });

  it("reads each tenant's settings from its own database and caches them apart", async () => {
    await saveScope(a, ["alpha"]);
    await saveScope(b, ["beta"]);
    await saveScope(b, ["beta", "gamma"]);
    const wa = await workspaceOf("tenant-a", a);
    const wb = await workspaceOf("tenant-b", b);
    expect(wa.config.repos).toEqual(["alpha"]);
    expect(wb.config.repos).toEqual(["beta", "gamma"]);
    expect(wa.version).not.toBe(wb.version);
    expect(await workspaceOf("tenant-a", a)).toBe(wa);
    expect(await workspaceOf("tenant-b", b)).toBe(wb);
  });

  it("a save in one tenant invalidates only that tenant's workspace", async () => {
    await saveScope(a, ["alpha"]);
    await saveScope(b, ["beta"]);
    const wa = await workspaceOf("tenant-a", a);
    const wb = await workspaceOf("tenant-b", b);
    await saveScope(a, ["alpha", "delta"]);
    invalidateWorkspace("tenant-a");
    const nextA = await workspaceOf("tenant-a", a);
    expect(nextA).not.toBe(wa);
    expect(nextA.config.repos).toEqual(["alpha", "delta"]);
    expect(await workspaceOf("tenant-b", b, true)).toBe(wb);
  });

  it("never reads another tenant's workspace through the built-in tenant's database", async () => {
    await expect(getWorkspace({ tenantId: "tenant-a", env: ENV })).rejects.toThrow(
      'the workspace of tenant "tenant-a" needs its database handle',
    );
  });
});
