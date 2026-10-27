import { generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { parseEncryptionKey } from "../settings/crypto";
import { saveWorkspace, UNSAVED_VERSION } from "../settings/store";
import { resetWorkspaceCache } from "../workspace";
import { createApp } from "./create-app";

const KEY = Buffer.alloc(32, 5).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 6).toString("base64");
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CONFIG = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/unused",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};

/**
 * Secrets stored before the secrets adapter existed (encrypted with the key parsed straight from
 * `SETTINGS_ENCRYPTION_KEY`) read the same through the default adapter with the same key.
 */
describeDb("the default secrets adapter", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    const saved = await saveWorkspace(t.db, parseEncryptionKey(KEY).key, {
      userId: null,
      expectedVersion: UNSAVED_VERSION,
      secrets: { github_private_key: PEM },
    });
    expect(saved).toMatchObject({ ok: true });
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  // The workspace is cached per tenant for the process; each case starts from the database.
  beforeEach(() => resetWorkspaceCache());

  const workspaceWith = async (key: string) => {
    const app = createApp({
      config: { ...CONFIG, SETTINGS_ENCRYPTION_KEY: key },
      adapters: { database: { forTenant: async () => t } },
    });
    const ctx = await app.context(new Request("http://localhost/"));
    return ctx!.workspace({ fresh: true });
  };

  it("decrypts secrets written by the previous code path with the same key", async () => {
    const { problems } = await workspaceWith(KEY);
    expect(problems.unreadable).toEqual([]);
    expect(problems.missingGithub).not.toContain("github_private_key");
  });

  it("reports them unreadable with another key", async () => {
    const { problems } = await workspaceWith(OTHER_KEY);
    expect(problems.unreadable).toContain("github_private_key");
  });
});
