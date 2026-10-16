import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CurrentUser } from "../auth/current-user";
import { Secret } from "../config/secret";
import { AttemptWindow } from "../ask/connection-test";
import { readAskSettings, saveAskSettings } from "../ask/settings";
import { startFakeProvider, type FakeProvider, type Script } from "../ask/testing/fake-provider";
import { askSettings, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { recordingLogger } from "../test-logger";
import { handleGetAsk, handleSaveAsk, handleTestAsk, type AskAdminDeps } from "./ask";

const KEY = "sk-admin-test-KEYVALUE-123456";
const SECRET_BASE_QUERY = "tenant-secret-token";

/** The shapes the tests read from responses; loose on purpose. */
type AdminJson = {
  error?: string;
  field?: string;
  result?: string;
  settings?: unknown;
  state?: unknown;
  providers: Record<
    string,
    { configured: boolean; missing: string[]; problem?: string; host?: string }
  >;
};

/** The provider settings a test describes with the old variable-style names. */
function providersFrom(e: Record<string, string>) {
  return async () => ({
    anthropicKey: e.AI_ANTHROPIC_API_KEY ? new Secret(e.AI_ANTHROPIC_API_KEY) : null,
    openaiBaseUrl: e.AI_OPENAI_BASE_URL ?? null,
    openaiKey: e.AI_OPENAI_API_KEY ? new Secret(e.AI_OPENAI_API_KEY) : null,
  });
}

describeDb("admin Ask API", () => {
  let t: TestDatabase;
  let fake: FakeProvider;
  let env: Record<string, string>;
  let recorder = recordingLogger();
  let adminId: number;

  beforeAll(async () => {
    t = await createTestDatabase();
    fake = await startFakeProvider();
    const [row] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", passwordHash: "x", role: "admin" })
      .returning({ id: users.id });
    adminId = row!.id;
  }, 60_000);
  afterAll(async () => {
    await fake?.close();
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    fake.reset();
    await t.db.delete(askSettings);
    recorder = recordingLogger();
    env = {
      AI_ANTHROPIC_API_KEY: KEY,
      AI_OPENAI_BASE_URL: `${fake.openAiBaseUrl}?token=${SECRET_BASE_QUERY}`,
    };
  });

  const admin = async (): Promise<CurrentUser> => ({
    id: adminId,
    email: "admin@example.com",
    role: "admin",
  });
  const denying = (status: 401 | 403) => async (): Promise<CurrentUser> => {
    throw Object.assign(new Error("denied"), { status });
  };

  function deps(over: Partial<AskAdminDeps> = {}): AskAdminDeps {
    return {
      db: t.db,
      providers: providersFrom(env),
      log: recorder.log,
      admin,
      providerDeps: { sleep: async () => undefined },
      testLimiter: new AttemptWindow(),
      ...over,
    };
  }

  function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/admin/ask", {
      method,
      headers: { "content-type": "application/json", host: "localhost", ...headers },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }

  const json = async (response: Response) => (await response.json()) as AdminJson;

  describe("access", () => {
    it("answers 401 and 403 to signed-out and non-admin users on all three endpoints", async () => {
      for (const [status, who] of [
        [401, denying(401)],
        [403, denying(403)],
      ] as const) {
        const d = deps({ admin: who });
        expect((await handleGetAsk(d)).status).toBe(status);
        expect((await handleSaveAsk(req("PUT", { enabled: false }), d)).status).toBe(status);
        expect(
          (await handleTestAsk(req("POST", { provider: "anthropic", model: "m" }), d)).status,
        ).toBe(status);
      }
      expect(fake.requests).toHaveLength(0);
      expect(await readAskSettings(t.db)).toEqual({ enabled: false, provider: null, model: null });
    });

    it("refuses cross-site writes and non-JSON bodies", async () => {
      const d = deps();
      const attempts: Record<string, string>[] = [
        { "sec-fetch-site": "cross-site" },
        { origin: "https://evil.example" },
        { "content-type": "text/plain" },
      ];
      for (const headers of attempts) {
        expect((await handleSaveAsk(req("PUT", { enabled: false }, headers), d)).status).toBe(403);
        expect(
          (await handleTestAsk(req("POST", { provider: "anthropic", model: "m" }, headers), d))
            .status,
        ).toBe(403);
      }
      expect(await readAskSettings(t.db)).toEqual({ enabled: false, provider: null, model: null });
    });
  });

  describe("GET", () => {
    it("is off by default and shows each provider's availability", async () => {
      const response = await handleGetAsk(deps());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await json(response)).toEqual({
        settings: { enabled: false, provider: null, model: null },
        providers: {
          anthropic: { configured: true, missing: [] },
          "openai-compatible": { configured: true, missing: [], host: "127.0.0.1" },
        },
        state: { state: "off" },
        credentials: {
          version: 0,
          openaiBaseUrl: null,
          anthropicKey: { set: false, updatedAt: null },
          openaiKey: { set: false, updatedAt: null },
        },
      });
    });

    it("names missing settings only, and reports a refused value without echoing it", async () => {
      const response = await handleGetAsk(
        deps({
          providers: providersFrom({
            AI_OPENAI_BASE_URL: "http://models.example.com/secret-path?k=zzz",
          }),
        }),
      );
      const body = await json(response);
      expect(body.providers.anthropic).toEqual({
        configured: false,
        missing: ["Anthropic API key"],
      });
      expect(body.providers["openai-compatible"]?.configured).toBe(false);
      expect(body.providers["openai-compatible"]?.problem).toMatch(/^OpenAI-compatible base URL /);
      expect(JSON.stringify(body)).not.toMatch(/secret-path|zzz|models\.example\.com/);
    });

    it("never contains a key or an endpoint beyond its host name", async () => {
      await saveAskSettings(
        t.db,
        { enabled: true, provider: "openai-compatible", model: "m" },
        null,
      );
      const text = JSON.stringify(await json(await handleGetAsk(deps())));
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(SECRET_BASE_QUERY);
      expect(text).not.toContain("/v1");
      expect(text).not.toContain(String(new URL(fake.origin).port));
      expect(text).toContain('"host":"127.0.0.1"');
    });

    it("reports unavailable by setting name when the saved provider lost its credentials", async () => {
      await saveAskSettings(t.db, { enabled: true, provider: "anthropic", model: "m" }, null);
      const body = await json(await handleGetAsk(deps({ providers: providersFrom({}) })));
      expect(body.state).toEqual({ state: "unavailable", missing: ["Anthropic API key"] });
      expect(body.settings).toEqual({ enabled: true, provider: "anthropic", model: "m" });
    });
  });

  describe("PUT", () => {
    it("saves the choice and turns Ask on, logging the change without a key", async () => {
      const response = await handleSaveAsk(
        req("PUT", { enabled: true, provider: "anthropic", model: "  claude-test  " }),
        deps(),
      );
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.settings).toEqual({ enabled: true, provider: "anthropic", model: "claude-test" });
      expect(body.state).toEqual({ state: "ready", provider: "anthropic", model: "claude-test" });
      expect(await readAskSettings(t.db)).toEqual(body.settings);

      const [change] = recorder.find("ask.settings.changed");
      expect(change).toMatchObject({
        adminId,
        enabled: true,
        provider: "anthropic",
        model: "claude-test",
      });
      expect(recorder.lines.join("")).not.toContain(KEY);
    });

    it("refuses an invalid body, naming the field, and changes nothing", async () => {
      const cases: [unknown, string][] = [
        [{}, "enabled"],
        [{ enabled: "yes" }, "enabled"],
        [{ enabled: false, extra: 1 }, "extra"],
        [{ enabled: false, provider: "openai" }, "provider"],
        [{ enabled: false, provider: 5 }, "provider"],
        [{ enabled: false, model: "" }, "model"],
        [{ enabled: false, model: "has space" }, "model"],
        [{ enabled: false, model: "x".repeat(101) }, "model"],
        [{ enabled: false, model: "bad‮name" }, "model"],
        [{ enabled: false, model: "tab\tname" }, "model"],
        [{ enabled: false, model: null }, "model"],
        [[], "body"],
      ];
      for (const [body, field] of cases) {
        const response = await handleSaveAsk(req("PUT", body), deps());
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect((await json(response)).field, JSON.stringify(body)).toBe(field);
      }
      expect((await handleSaveAsk(req("PUT", "{nope"), deps())).status).toBe(400);
      expect((await handleSaveAsk(req("PUT", "x".repeat(5000)), deps())).status).toBe(413);
      expect(await readAskSettings(t.db)).toEqual({ enabled: false, provider: null, model: null });
    });

    it("refuses to turn Ask on without a provider, a model or usable credentials", async () => {
      const d = deps();
      let response = await handleSaveAsk(req("PUT", { enabled: true, model: "m" }), d);
      expect(response.status).toBe(400);
      expect((await json(response)).field).toBe("provider");

      response = await handleSaveAsk(req("PUT", { enabled: true, provider: "anthropic" }), d);
      expect((await json(response)).field).toBe("model");

      response = await handleSaveAsk(
        req("PUT", { enabled: true, provider: "anthropic", model: "m" }),
        deps({ providers: providersFrom({}) }),
      );
      const body = await json(response);
      expect(response.status).toBe(400);
      expect(body.field).toBe("provider");
      expect(body.error).toContain("Anthropic API key");

      response = await handleSaveAsk(
        req("PUT", { enabled: true, provider: "openai-compatible", model: "m" }),
        deps({ providers: providersFrom({ AI_OPENAI_BASE_URL: "http://models.example.com" }) }),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error).toMatch(/OpenAI-compatible base URL/);

      expect(await readAskSettings(t.db)).toEqual({ enabled: false, provider: null, model: null });
    });

    it("uses the stored provider and model when turning on without repeating them", async () => {
      await handleSaveAsk(
        req("PUT", { enabled: false, provider: "anthropic", model: "m1" }),
        deps(),
      );
      const response = await handleSaveAsk(req("PUT", { enabled: true }), deps());
      expect(response.status).toBe(200);
      expect((await json(response)).state).toEqual({
        state: "ready",
        provider: "anthropic",
        model: "m1",
      });
    });

    it("turning off keeps the saved provider and model", async () => {
      await handleSaveAsk(
        req("PUT", { enabled: true, provider: "openai-compatible", model: "llama3.1:8b" }),
        deps(),
      );
      const body = await json(await handleSaveAsk(req("PUT", { enabled: false }), deps()));
      expect(body.settings).toEqual({
        enabled: false,
        provider: "openai-compatible",
        model: "llama3.1:8b",
      });
      expect(body.state).toEqual({ state: "off" });
    });

    it("lets an admin save a choice while off even when credentials are missing", async () => {
      const response = await handleSaveAsk(
        req("PUT", { enabled: false, provider: "anthropic", model: "m" }),
        deps({ providers: providersFrom({}) }),
      );
      expect(response.status).toBe(200);
    });

    it("records who changed it", async () => {
      await handleSaveAsk(
        req("PUT", { enabled: false, provider: "anthropic", model: "m" }),
        deps(),
      );
      const [row] = await t.db.select().from(askSettings);
      expect(row?.updatedBy).toBe(adminId);
    });
  });

  describe("POST test", () => {
    const test = (
      over: Partial<AskAdminDeps> = {},
      body: unknown = { provider: "openai-compatible", model: "m" },
    ) => handleTestAsk(req("POST", body), deps({ testDeadlineMs: 300, ...over }));

    it("reports ok for a working provider and model, with one fixed small request", async () => {
      const response = await test();
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ result: "ok" });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.stream).toBe(false);
      expect(fake.requests[0]?.body).toMatchObject({
        model: "m",
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      });
    });

    it("tests the Anthropic provider through its adapter too", async () => {
      const response = await test(
        {
          providerDeps: { sleep: async () => undefined, anthropicEndpoint: fake.anthropicEndpoint },
        },
        { provider: "anthropic", model: "claude-x" },
      );
      expect(await json(response)).toEqual({ result: "ok" });
      expect(fake.requests[0]?.headers["x-api-key"]).toBe(KEY);
    });

    it("maps each provider outcome to one fixed word, never provider text", async () => {
      const cases: [Script, string][] = [
        [{ kind: "status", status: 401 }, "rejected"],
        [{ kind: "status", status: 403 }, "rejected"],
        [{ kind: "status", status: 404 }, "not_found"],
        [{ kind: "status", status: 429 }, "unavailable"],
        [{ kind: "status", status: 500 }, "unavailable"],
        [{ kind: "status", status: 503 }, "unavailable"],
        [{ kind: "stall" }, "timeout"],
        [{ kind: "malformed" }, "unavailable"],
        [{ kind: "filtered", chunks: ["x"] }, "unavailable"],
      ];
      for (const [behavior, expected] of cases) {
        fake.reset();
        fake.setDefault(behavior);
        const response = await test();
        expect(response.status).toBe(200);
        const body = await json(response);
        expect(body, JSON.stringify(behavior)).toEqual({ result: expected });
        expect(JSON.stringify(body)).not.toContain("SECRET-PROVIDER-TEXT");
      }
    });

    it("does not change the saved choice", async () => {
      await saveAskSettings(t.db, { enabled: true, provider: "anthropic", model: "saved" }, null);
      await test();
      expect(await readAskSettings(t.db)).toEqual({
        enabled: true,
        provider: "anthropic",
        model: "saved",
      });
    });

    it("validates like a save and refuses a provider with no credentials", async () => {
      for (const [body, field] of [
        [{ provider: "x", model: "m" }, "provider"],
        [{ provider: "anthropic", model: "bad name" }, "model"],
        [{ provider: "anthropic" }, "model"],
        [{ provider: "anthropic", model: "m", extra: 1 }, "extra"],
      ] as const) {
        const response = await test({}, body);
        expect(response.status).toBe(400);
        expect((await json(response)).field).toBe(field);
      }
      const response = await test(
        { providers: providersFrom({}) },
        { provider: "anthropic", model: "m" },
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error).toContain("Anthropic API key");
      expect(fake.requests).toHaveLength(0);
    });

    it("limits tests to five a minute, answering 429 with Retry-After", async () => {
      let now = 1_000_000;
      const limiter = new AttemptWindow(5, 60_000, () => now);
      for (let i = 0; i < 5; i += 1)
        expect((await test({ testLimiter: limiter })).status).toBe(200);
      const sixth = await test({ testLimiter: limiter });
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(fake.requests).toHaveLength(5);
      now += 61_000;
      expect((await test({ testLimiter: limiter })).status).toBe(200);
    });

    it("logs the admin, provider, model and result but no key or provider text", async () => {
      fake.setDefault({ kind: "status", status: 401 });
      await test();
      const [line] = recorder.find("ask.settings.tested");
      expect(line).toMatchObject({
        adminId,
        provider: "openai-compatible",
        model: "m",
        result: "rejected",
      });
      const logs = recorder.lines.join("");
      for (const leaked of [KEY, SECRET_BASE_QUERY, "SECRET-PROVIDER-TEXT"]) {
        expect(logs).not.toContain(leaked);
      }
    });
  });
});

describe("AttemptWindow", () => {
  it("allows the limit within the window and frees places as attempts age out", () => {
    let now = 0;
    const window = new AttemptWindow(2, 1000, () => now);
    expect(window.attempt().ok).toBe(true);
    now = 400;
    expect(window.attempt().ok).toBe(true);
    now = 500;
    expect(window.attempt()).toEqual({ ok: false, retryAfterSeconds: 1 });
    now = 1000;
    expect(window.attempt().ok).toBe(true); // the first has aged out
    expect(window.attempt().ok).toBe(false);
  });
});

describeDb("admin Ask page data", () => {
  it("is refused to a non-administrator before anything is read", async () => {
    const { getAdminAskView } = await import("./ask");
    await expect(
      getAdminAskView({
        db: {} as never,
        admin: async () => {
          throw Object.assign(new Error("forbidden"), { status: 403 });
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
