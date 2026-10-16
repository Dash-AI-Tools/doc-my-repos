import { generateKeyPairSync, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AttemptWindow } from "../ask/connection-test";
import type { CurrentUser } from "../auth/current-user";
import { settingsAudit, users, workspaceSecrets, workspaceSettings } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { parseEncryptionKey } from "../settings/crypto";
import { readSecrets, readSettings } from "../settings/store";
import { FakeGitHub } from "../sync/fake-github";
import { ENCRYPTION_KEY_VAR } from "../settings/crypto";
import { getWorkspace, invalidateWorkspace } from "../workspace";
import { captureOutput } from "../test-logger";
import {
  handleGetSettings,
  handleSaveProviderCredentials,
  handleSaveSettings,
  handleTestGithub,
  type SettingsAdminDeps,
} from "./settings";

const KEY = parseEncryptionKey(randomBytes(32).toString("base64")).key!;
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const PEM_BODY = PEM.split("\n")[1]!;
const WEBHOOK = "webhook-secret-SENTINEL-0123";
const ANTHROPIC = "sk-ant-SENTINEL-4567890123";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describeDb("admin workspace settings API", () => {
  let t: TestDatabase;
  let adminId: number;

  beforeAll(async () => {
    t = await createTestDatabase();
    const [row] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", passwordHash: "x", role: "admin" })
      .returning({ id: users.id });
    adminId = row!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE workspace_settings, workspace_secrets, settings_audit`);
  });

  const admin = async (): Promise<CurrentUser> => ({
    id: adminId,
    email: "admin@example.com",
    role: "admin",
  });
  const denying = (status: 401 | 403) => async (): Promise<CurrentUser> => {
    throw Object.assign(new Error("denied"), { status });
  };
  const PROBLEMS = {
    missingGithub: [],
    encryptionKey: null,
    unreadable: [],
    invalidStored: false,
  };

  function deps(over: Partial<SettingsAdminDeps> = {}): SettingsAdminDeps {
    return {
      db: t.db,
      admin,
      encryptionKey: () => KEY,
      problems: async () => PROBLEMS,
      testLimiter: new AttemptWindow(),
      ...over,
    };
  }

  function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", host: "localhost", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  const put = (body: unknown, d = deps()) =>
    handleSaveSettings(req("PUT", "/api/admin/settings", body), d);
  const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
  const version = async () => (await readSettings(t.db)).version;

  describe("access", () => {
    it("refuses a signed-out visitor and a non-administrator on every endpoint", async () => {
      for (const status of [401, 403] as const) {
        const d = deps({ admin: denying(status) });
        const responses = [
          await handleGetSettings(d),
          await handleSaveSettings(req("PUT", "/x", { expectedVersion: 0 }), d),
          await handleSaveProviderCredentials(req("PUT", "/x", { expectedVersion: 0 }), d),
          await handleTestGithub(req("POST", "/x", {}), d),
        ];
        for (const response of responses) expect(response.status).toBe(status);
      }
      expect(await t.db.select().from(workspaceSettings)).toEqual([]);
    });

    it("refuses a cross-site write and a body that is not JSON, and a huge one", async () => {
      const cross = await handleSaveSettings(
        req(
          "PUT",
          "/api/admin/settings",
          { expectedVersion: 0 },
          { origin: "http://evil.example" },
        ),
        deps(),
      );
      expect(cross.status).toBe(403);
      expect((await put("{not json")).status).toBe(400);
      expect(
        (await put(JSON.stringify({ expectedVersion: 0, pad: "x".repeat(70_000) }))).status,
      ).toBe(413);
    });
  });

  describe("GET", () => {
    it("shows defaults, no secret set, and what is missing, uncached", async () => {
      const response = await handleGetSettings(
        deps({ problems: async () => ({ ...PROBLEMS, missingGithub: ["github.appId"] }) }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await json(response);
      expect(body.version).toBe(0);
      expect(body.settings.limits.maxDocsPerRepo).toBe(2000);
      expect(body.secrets.github_private_key).toEqual({ set: false, updatedAt: null });
      expect(body.problems.missingGithub).toEqual(["github.appId"]);
    });
  });

  describe("PUT /api/admin/settings", () => {
    it("saves settings and secrets, returns the new view, and never returns a secret", async () => {
      const response = await put({
        expectedVersion: 0,
        settings: { github: { appId: 12, installationId: 34 }, repos: ["api"] },
        secrets: { github_private_key: PEM, github_webhook_secret: WEBHOOK },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const secret of [PEM_BODY, WEBHOOK, "PRIVATE KEY"]) expect(text).not.toContain(secret);
      const body = JSON.parse(text) as Json;
      expect(body.version).toBe(1);
      expect(body.settings.github).toEqual({ appId: 12, installationId: 34 });
      expect(body.secrets.github_private_key.set).toBe(true);
      expect(Object.keys(body.secrets.github_private_key).sort()).toEqual(["set", "updatedAt"]);

      const stored = await readSecrets(t.db, KEY);
      expect(stored.values.github_webhook_secret?.reveal()).toBe(WEBHOOK);
    });

    it("keeps a secret when its field is empty or missing, replaces it, and clears it on null", async () => {
      await put({
        expectedVersion: 0,
        secrets: { github_webhook_secret: WEBHOOK, anthropic_api_key: ANTHROPIC },
      });
      await put({
        expectedVersion: 1,
        secrets: { github_webhook_secret: "", anthropic_api_key: "   " },
      });
      let stored = await readSecrets(t.db, KEY);
      expect(stored.values.github_webhook_secret?.reveal()).toBe(WEBHOOK);
      expect(stored.values.anthropic_api_key?.reveal()).toBe(ANTHROPIC);

      await put({
        expectedVersion: await version(),
        secrets: { github_webhook_secret: "another-secret-0123456789" },
      });
      stored = await readSecrets(t.db, KEY);
      expect(stored.values.github_webhook_secret?.reveal()).toBe("another-secret-0123456789");

      await put({ expectedVersion: await version(), secrets: { anthropic_api_key: null } });
      stored = await readSecrets(t.db, KEY);
      expect(stored.values.anthropic_api_key).toBeUndefined();
      expect(stored.values.github_webhook_secret).toBeDefined();
    });

    it("refuses invalid values with the field named, echoes nothing, and changes nothing", async () => {
      const response = await put({
        expectedVersion: 0,
        settings: { repos: ["a"], exclude: ["b"], limits: { maxFileBytes: 5 } },
        secrets: { github_private_key: `not a key ${WEBHOOK}`, github_webhook_secret: "short" },
      });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("exclude: use either");
      expect(text).toContain("limits.maxFileBytes");
      expect(text).toContain("GitHub App private key:");
      expect(text).toContain("GitHub webhook secret: must be at least 16");
      expect(text).not.toContain(WEBHOOK);
      expect(text).not.toContain('short"');
      expect(await t.db.select().from(workspaceSettings)).toEqual([]);
      expect(await t.db.select().from(settingsAudit)).toEqual([]);
    });

    it("refuses a request with unknown fields or secret names", async () => {
      expect((await put({ expectedVersion: 0, extra: 1 })).status).toBe(400);
      const unknown = await put({
        expectedVersion: 0,
        secrets: { session_secret: "x".repeat(20) },
      });
      expect(unknown.status).toBe(400);
      expect((await put({ settings: {} })).status).toBe(400);
      expect((await put({ expectedVersion: -1 })).status).toBe(400);
    });

    it("answers 409 for a stale save and saves nothing from it", async () => {
      await put({ expectedVersion: 0, settings: { sync: { intervalMinutes: 30 } } });
      const stale = await put({
        expectedVersion: 0,
        settings: { sync: { intervalMinutes: 15 } },
        secrets: { github_webhook_secret: WEBHOOK },
      });
      expect(stale.status).toBe(409);
      expect((await json(stale)).code).toBe("conflict");
      expect((await readSettings(t.db)).settings.sync.intervalMinutes).toBe(30);
      expect((await readSecrets(t.db, KEY)).values.github_webhook_secret).toBeUndefined();
    });

    it("refuses a secret when the server has no usable encryption key", async () => {
      const response = await put(
        { expectedVersion: 0, secrets: { anthropic_api_key: ANTHROPIC } },
        deps({ encryptionKey: () => null }),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).problems.join(" ")).toContain("SETTINGS_ENCRYPTION_KEY");
      expect(await t.db.select().from(workspaceSecrets)).toEqual([]);
    });

    it("writes an audit row of field names only, and a log line with names and ids only", async () => {
      const output = captureOutput("debug");
      try {
        await put({
          expectedVersion: 0,
          settings: { github: { appId: 12 } },
          secrets: { github_webhook_secret: WEBHOOK },
        });
        await put({ expectedVersion: 99, secrets: { github_webhook_secret: "x".repeat(20) } });
        await put({ expectedVersion: 1, secrets: { github_private_key: `bad ${PEM_BODY}` } });
        const printed = output.text();
        for (const secret of [WEBHOOK, PEM_BODY, "x".repeat(20)])
          expect(printed).not.toContain(secret);
        const records = output.records();
        expect(records.find((r) => r.event === "settings.changed")).toMatchObject({
          userId: adminId,
          fields: ["github.appId", "secret:github_webhook_secret"],
        });
        expect(
          records.find((r) => r.event === "settings.save_refused" && r.reason === "invalid"),
        ).toMatchObject({
          fields: ["GitHub App private key"],
        });
      } finally {
        output.restore();
      }
      const audit = await t.db.select().from(settingsAudit);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        userId: adminId,
        fields: ["github.appId", "secret:github_webhook_secret"],
      });
      expect(JSON.stringify(audit)).not.toContain(WEBHOOK);
    });
  });

  describe("PUT /api/admin/ask/credentials", () => {
    const creds = (body: unknown, d = deps()) =>
      handleSaveProviderCredentials(req("PUT", "/api/admin/ask/credentials", body), d);

    it("sets the endpoint and keys without touching any other setting", async () => {
      await put({ expectedVersion: 0, settings: { github: { appId: 5 }, repos: ["api"] } });
      const response = await creds({
        expectedVersion: 1,
        openaiBaseUrl: "https://models.example.com/v1",
        secrets: { anthropic_api_key: ANTHROPIC },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(ANTHROPIC);
      const saved = await readSettings(t.db);
      expect(saved.settings.providers.openaiBaseUrl).toBe("https://models.example.com/v1");
      expect(saved.settings.github.appId).toBe(5);
      expect(saved.settings.repos).toEqual(["api"]);
      expect((await readSecrets(t.db, KEY)).values.anthropic_api_key?.reveal()).toBe(ANTHROPIC);
    });

    it("clears the endpoint with null, refuses an insecure one, and only accepts provider keys", async () => {
      await creds({ expectedVersion: 0, openaiBaseUrl: "http://127.0.0.1:11434/v1" });
      expect((await readSettings(t.db)).settings.providers.openaiBaseUrl).toBe(
        "http://127.0.0.1:11434/v1",
      );

      const insecure = await creds({
        expectedVersion: 1,
        openaiBaseUrl: "http://models.example.com/secret-path",
      });
      expect(insecure.status).toBe(400);
      const text = await insecure.text();
      expect(text).toContain("providers.openaiBaseUrl");
      expect(text).not.toContain("secret-path");

      await creds({ expectedVersion: 1, openaiBaseUrl: null });
      expect((await readSettings(t.db)).settings.providers.openaiBaseUrl).toBeUndefined();

      expect(
        (await creds({ expectedVersion: 2, secrets: { github_private_key: PEM } })).status,
      ).toBe(400);
    });

    it("keeps keys when their fields are empty, and answers 409 when stale", async () => {
      await creds({ expectedVersion: 0, secrets: { anthropic_api_key: ANTHROPIC } });
      await creds({ expectedVersion: 1, secrets: { anthropic_api_key: "" } });
      expect((await readSecrets(t.db, KEY)).values.anthropic_api_key?.reveal()).toBe(ANTHROPIC);
      expect(
        (await creds({ expectedVersion: 0, secrets: { anthropic_api_key: "other-key-123" } }))
          .status,
      ).toBe(409);
    });
  });

  describe("applying without a restart", () => {
    const ENV = { [ENCRYPTION_KEY_VAR]: randomBytes(32).toString("base64") };

    it("a saved or cleared provider key shows in the workspace at once, with no wait", async () => {
      const key = parseEncryptionKey(ENV[ENCRYPTION_KEY_VAR]).key!;
      invalidateWorkspace();
      const withKey = deps({ encryptionKey: () => key });
      const creds = (body: unknown) =>
        handleSaveProviderCredentials(req("PUT", "/api/admin/ask/credentials", body), withKey);

      expect(
        (await creds({ expectedVersion: 0, secrets: { anthropic_api_key: ANTHROPIC } })).status,
      ).toBe(200);
      const on = await getWorkspace({ handle: t, env: ENV });
      expect(on.providers.anthropicKey?.reveal()).toBe(ANTHROPIC);

      expect(
        (await creds({ expectedVersion: await version(), secrets: { anthropic_api_key: null } }))
          .status,
      ).toBe(200);
      const off = await getWorkspace({ handle: t, env: ENV });
      expect(off.providers.anthropicKey).toBeNull();
      invalidateWorkspace();
    });
  });

  describe("POST /api/admin/settings/test", () => {
    const fake = () =>
      new FakeGitHub({
        installationId: 4242,
        repos: [
          { id: 1, name: "a", files: {} },
          { id: 2, name: "b", files: {} },
        ],
      });
    const test = (body: unknown, g: FakeGitHub, d: Partial<SettingsAdminDeps> = {}) =>
      handleTestGithub(
        req("POST", "/api/admin/settings/test", body),
        deps({ githubTest: { fetch: g.fetch }, ...d }),
      );

    it("tests submitted values and reports the repository count, saving nothing", async () => {
      const g = fake();
      const response = await test({ appId: 12, installationId: 4242, privateKey: PEM }, g);
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ result: "ok", repositories: 2 });
      expect(await t.db.select().from(workspaceSettings)).toEqual([]);
      expect(await t.db.select().from(workspaceSecrets)).toEqual([]);
    });

    it("falls back to the stored values for anything left out", async () => {
      await put({
        expectedVersion: 0,
        settings: { github: { appId: 12, installationId: 4242 } },
        secrets: { github_private_key: PEM },
      });
      const response = await test({}, fake());
      expect(await json(response)).toEqual({ result: "ok", repositories: 2 });
    });

    it("asks for what is missing when nothing is submitted or stored", async () => {
      const response = await test({}, fake());
      expect(response.status).toBe(400);
      expect((await json(response)).error).toContain("App id, installation id and private key");
    });

    it("maps GitHub failures to fixed words without GitHub text", async () => {
      const gone = fake();
      gone.installationGone = true;
      expect(
        await json(await test({ appId: 12, installationId: 4242, privateKey: PEM }, gone)),
      ).toEqual({
        result: "not_found",
      });

      const rejected = fake();
      rejected.fail({ path: /access_tokens$/, status: 401, times: 5 });
      const text = await (
        await test({ appId: 12, installationId: 4242, privateKey: PEM }, rejected)
      ).text();
      expect(JSON.parse(text)).toEqual({ result: "rejected" });

      const down = fake();
      down.fail({ path: "/installation/repositories", status: 500, times: 5 });
      expect(
        await json(await test({ appId: 12, installationId: 4242, privateKey: PEM }, down)),
      ).toEqual({
        result: "unavailable",
      });
    });

    it("refuses a malformed key with a fixed message that does not echo it", async () => {
      const response = await test(
        { appId: 12, installationId: 4242, privateKey: `junk ${WEBHOOK}` },
        fake(),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("GitHub App private key:");
      expect(text).not.toContain(WEBHOOK);
    });

    it("limits testing to five a minute with Retry-After", async () => {
      const limiter = new AttemptWindow();
      const g = fake();
      for (let i = 0; i < 5; i++) {
        expect(
          (
            await test({ appId: 12, installationId: 4242, privateKey: PEM }, g, {
              testLimiter: limiter,
            })
          ).status,
        ).toBe(200);
      }
      const spam = await test({ appId: 12, installationId: 4242, privateKey: PEM }, g, {
        testLimiter: limiter,
      });
      expect(spam.status).toBe(429);
      expect(Number(spam.headers.get("retry-after"))).toBeGreaterThan(0);
    });
  });
});
