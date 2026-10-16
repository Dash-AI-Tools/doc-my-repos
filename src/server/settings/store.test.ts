import { generateKeyPairSync, randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { settingsAudit, users, workspaceSecrets, workspaceSettings } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { parseEncryptionKey, type EncryptionKey } from "./crypto";
import { secretProblem } from "./secret-validation";
import {
  changedPaths,
  readSecretStatuses,
  readSecrets,
  readSettings,
  readVersion,
  saveWorkspace,
  UNSAVED_VERSION,
} from "./store";

const newKey = (): EncryptionKey => {
  const parsed = parseEncryptionKey(randomBytes(32).toString("base64"));
  if (parsed.key === null) throw new Error("key");
  return parsed.key;
};

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const WEBHOOK = "webhook-secret-0123456789";

describe("changedPaths", () => {
  it("lists the leaf fields that differ", () => {
    expect(
      changedPaths(
        { github: { appId: 1 }, limits: { a: 1, b: 2 }, repos: ["x"] },
        { github: { appId: 2 }, limits: { a: 1, b: 2 }, repos: ["x", "y"] },
      ),
    ).toEqual(["github.appId", "repos"]);
    expect(changedPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe("secretProblem", () => {
  it("accepts good values and gives fixed texts that never echo the value", () => {
    expect(secretProblem("github_private_key", PEM)).toBeNull();
    expect(secretProblem("github_webhook_secret", WEBHOOK)).toBeNull();
    expect(secretProblem("anthropic_api_key", "sk-ant-abc123")).toBeNull();

    const bad = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key-hunter2\n-----END RSA PRIVATE KEY-----";
    expect(secretProblem("github_private_key", bad)).toMatch(/^GitHub App private key: /);
    expect(secretProblem("github_private_key", bad)).not.toContain("hunter2");
    expect(secretProblem("github_webhook_secret", "short")).toMatch(/at least 16/);
    expect(secretProblem("github_webhook_secret", "replace-with-webhook-secret")).toMatch(
      /placeholder/,
    );
    expect(secretProblem("openai_api_key", "has space")).toMatch(/spaces/);
    expect(secretProblem("anthropic_api_key", "  ")).toMatch(/must not be empty/);
  });
});

describeDb("workspace settings store", () => {
  let t: TestDatabase;
  let adminId: number;
  beforeAll(async () => {
    t = await createTestDatabase();
    const [u] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", passwordHash: "x" })
      .returning();
    adminId = u!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.delete(settingsAudit);
    await t.db.delete(workspaceSecrets);
    await t.db.delete(workspaceSettings);
  });

  it("reads defaults at version 0 before anything is saved", async () => {
    const snap = await readSettings(t.db);
    expect(snap).toMatchObject({ version: UNSAVED_VERSION, valid: true, updatedAt: null });
    expect(snap.settings.limits.maxDocsPerRepo).toBe(2000);
    expect(await readVersion(t.db)).toBe(0);
    const statuses = await readSecretStatuses(t.db);
    expect(Object.values(statuses).every((s) => !s.set)).toBe(true);
  });

  it("saves settings, bumps the version and writes an audit row of field names", async () => {
    const key = newKey();
    const first = await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 0,
      settings: { github: { appId: 12, installationId: 34 }, repos: ["api"] },
    });
    expect(first).toMatchObject({ ok: true, version: 1 });
    if (first.ok) expect(first.changed).toEqual(["github.appId", "github.installationId", "repos"]);

    const second = await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 1,
      settings: { github: { appId: 13, installationId: 34 }, repos: ["api"] },
    });
    expect(second).toMatchObject({ ok: true, version: 2, changed: ["github.appId"] });

    const snap = await readSettings(t.db);
    expect(snap.version).toBe(2);
    expect(snap.settings.github.appId).toBe(13);
    const audit = await t.db.select().from(settingsAudit);
    expect(audit.map((a) => a.fields)).toEqual([
      ["github.appId", "github.installationId", "repos"],
      ["github.appId"],
    ]);
    expect(audit.every((a) => a.userId === adminId)).toBe(true);
  });

  it("refuses an invalid change with field names and changes nothing", async () => {
    const result = await saveWorkspace(t.db, newKey(), {
      userId: adminId,
      expectedVersion: 0,
      settings: { repos: ["a"], exclude: ["b"], limits: { maxFileBytes: 5 } },
      secrets: { github_webhook_secret: "short" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid") {
      const text = result.problems.join("\n");
      expect(text).toMatch(/exclude: use either/);
      expect(text).toMatch(/limits.maxFileBytes/);
      expect(text).toMatch(/GitHub webhook secret: must be at least 16/);
      expect(text).not.toContain("short");
    }
    expect(await readVersion(t.db)).toBe(0);
    expect(await t.db.select().from(settingsAudit)).toEqual([]);
  });

  it("refuses a stale save and saves nothing", async () => {
    const key = newKey();
    await saveWorkspace(t.db, key, { userId: adminId, expectedVersion: 0, settings: {} });
    const mine = await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 1,
      settings: { sync: { intervalMinutes: 30 } },
    });
    expect(mine.ok).toBe(true);
    const stale = await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 1,
      settings: { sync: { intervalMinutes: 15 } },
      secrets: { github_webhook_secret: WEBHOOK },
    });
    expect(stale).toEqual({ ok: false, reason: "conflict" });
    expect((await readSettings(t.db)).settings.sync.intervalMinutes).toBe(30);
    expect((await readSecretStatuses(t.db)).github_webhook_secret.set).toBe(false);
  });

  it("refuses a first save from a stale 'unsaved' base once a row exists", async () => {
    const key = newKey();
    await saveWorkspace(t.db, key, { userId: adminId, expectedVersion: 0, settings: {} });
    const again = await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 0,
      settings: {},
    });
    expect(again).toEqual({ ok: false, reason: "conflict" });
  });

  it("stores secrets encrypted, reports only set/updatedAt, and decrypts with the key", async () => {
    const key = newKey();
    const saved = await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 0,
      secrets: { github_private_key: PEM, github_webhook_secret: WEBHOOK },
    });
    expect(saved).toMatchObject({ ok: true, version: 1 });

    const rows = await t.db.select().from(workspaceSecrets);
    expect(rows).toHaveLength(2);
    const stored =
      JSON.stringify(rows) + JSON.stringify(await t.db.select().from(workspaceSettings));
    expect(stored).not.toContain("PRIVATE KEY");
    expect(stored).not.toContain(WEBHOOK);
    const audit = JSON.stringify(await t.db.select().from(settingsAudit));
    expect(audit).not.toContain(WEBHOOK);
    expect(audit).toContain("secret:github_webhook_secret");

    const statuses = await readSecretStatuses(t.db);
    expect(statuses.github_private_key.set).toBe(true);
    expect(Object.keys(statuses.github_private_key).sort()).toEqual(["set", "updatedAt"]);

    const { values, unreadable } = await readSecrets(t.db, key);
    expect(unreadable).toEqual([]);
    expect(values.github_webhook_secret?.reveal()).toBe(WEBHOOK);
    expect(values.github_private_key?.reveal()).toBe(PEM.trim());
    expect(JSON.stringify(values)).not.toContain(WEBHOOK);
  });

  it("keeps a secret that is not in the change, replaces one that is, and clears on null", async () => {
    const key = newKey();
    await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 0,
      secrets: { github_webhook_secret: WEBHOOK, anthropic_api_key: "sk-ant-one" },
    });
    await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 1,
      settings: { sync: { intervalMinutes: 30 } },
    });
    expect((await readSecrets(t.db, key)).values.anthropic_api_key?.reveal()).toBe("sk-ant-one");

    await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 2,
      secrets: { anthropic_api_key: "sk-ant-two" },
    });
    expect((await readSecrets(t.db, key)).values.anthropic_api_key?.reveal()).toBe("sk-ant-two");

    await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 3,
      secrets: { anthropic_api_key: null },
    });
    const statuses = await readSecretStatuses(t.db);
    expect(statuses.anthropic_api_key.set).toBe(false);
    expect(statuses.github_webhook_secret.set).toBe(true);
  });

  it("cannot save a secret without an encryption key, and reports a wrong key as unreadable", async () => {
    const noKey = await saveWorkspace(t.db, null, {
      userId: adminId,
      expectedVersion: 0,
      secrets: { anthropic_api_key: "sk-ant-one" },
    });
    expect(noKey).toMatchObject({ ok: false, reason: "invalid" });
    expect(await readVersion(t.db)).toBe(0);

    await saveWorkspace(t.db, newKey(), {
      userId: adminId,
      expectedVersion: 0,
      secrets: { anthropic_api_key: "sk-ant-one" },
    });
    const wrong = await readSecrets(t.db, newKey());
    expect(wrong.values).toEqual({});
    expect(wrong.unreadable).toEqual(["anthropic_api_key"]);
  });

  it("makes a ciphertext copied to another secret name unreadable", async () => {
    const key = newKey();
    await saveWorkspace(t.db, key, {
      userId: adminId,
      expectedVersion: 0,
      secrets: { anthropic_api_key: "sk-ant-one" },
    });
    const [row] = await t.db.select().from(workspaceSecrets);
    await t.db.insert(workspaceSecrets).values({ ...row!, name: "openai_api_key" });
    const { values, unreadable } = await readSecrets(t.db, key);
    expect(Object.keys(values)).toEqual(["anthropic_api_key"]);
    expect(unreadable).toEqual(["openai_api_key"]);
  });

  it("falls back to defaults and says so when the stored JSON is no longer valid", async () => {
    await t.db
      .insert(workspaceSettings)
      .values({ id: 1, data: { limits: { maxFileBytes: 1 } }, version: 4 });
    const snap = await readSettings(t.db);
    expect(snap).toMatchObject({ valid: false, version: 4 });
    expect(snap.settings.limits.maxFileBytes).toBe(262144);
  });
});
