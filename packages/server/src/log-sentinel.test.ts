import { createHmac, generateKeyPairSync } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { serveAsset } from "./assets/serve";
import { PNG } from "./assets/test-images";
import { createDb, type DbHandle } from "./db/client";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { logger } from "./log";
import { findAssetRepo } from "./queries/assets";
import {
  handleSaveProviderCredentials,
  handleSaveSettings,
  handleTestGithub,
} from "./admin/settings";
import { ENCRYPTION_KEY_VAR, parseEncryptionKey } from "./settings/crypto";
import { readVersion, saveWorkspace } from "./settings/store";
import { createWorkspace, requireGitHub, resetWorkspaceCache, type GitHubParts } from "./workspace";
import { repoNameSelection } from "./sync/discovery";
import { FakeGitHub } from "../../../tests/support/fake-github";
import { handleManualSync } from "./sync/manual-sync";
import { getSyncService, readConfiguredSyncSecret } from "./sync/service";
import { captureOutput, type CapturedOutput } from "./test-logger";
import { handleWebhookRequest } from "./webhooks/endpoint";
import { createBackgroundTasks } from "./webhooks/router";
import { createWebhookDispatch, readConfiguredWebhookSecret } from "./webhooks/service";

/**
 * Task 12.4 verification: credentials never appear in log output. Runs the real flows (token
 * minting, `/api/sync`, full and single-repo syncs, webhook verification and dispatch, the image
 * proxy) over the fake GitHub and a real test database, with every log line printed by the
 * default logger at `debug` and every console call captured, in success and failure paths. Then
 * no sentinel, and no 8-character piece of one, may appear anywhere in that output.
 *
 * The sentinels are shaped so the logger's value scrubbing does NOT recognise them (short
 * dot-separated lower-case runs, no known prefix) and share no 8-character piece with ordinary log
 * text: the test proves that no call site hands a credential to the logger, not only that the
 * scrubber would catch a familiar shape.
 */

const INSTALLATION_TOKEN = "qz7x.k2vw.q9fm.l4dr.t8pa";
const WEBHOOK_SECRET = "hy3n.c6ub.j1ze.w5ko.g0ra";
const SYNC_SECRET = "vb8m.x2qp.n7ld.f3zs.y6ck";
const SESSION_SECRET = "n4qr.t7wb.e9xk.p2md.h6sa";
const DB_PASSWORD = "kp2w.z9xq.m4tv";
const ENCRYPTION_KEY = Buffer.from("qj4n-w8hd-r1ce-m6ux-b3vt-pa8s-zk2w-f5ol").toString("base64");
const ANTHROPIC_KEY = "xt5k.p0ge.d7ns.u2bq.z9la";
const INSTALLATION_ID = 4242;
const HANDBOOK_ID = 101;
const METRICS_ID = 202;

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
/** The base64 body of the private key, without the BEGIN/END lines and newlines. */
const KEY_BODY = PEM.split("\n")
  .filter((l) => l !== "" && !l.startsWith("-----"))
  .join("");

const ENV = {
  DATABASE_URL: `postgres://app:${DB_PASSWORD}@db.invalid:5432/docmyrepos`,
  SYNC_SECRET,
  SESSION_SECRET,
  [ENCRYPTION_KEY_VAR]: ENCRYPTION_KEY,
  LOG_LEVEL: "debug",
};
const KEY = parseEncryptionKey(ENCRYPTION_KEY).key;

/** Every 8-character piece of `value` (all of it when shorter). */
function pieces(value: string, size = 8): string[] {
  if (value.length <= size) return [value];
  const out = new Set<string>();
  for (let i = 0; i + size <= value.length; i++) out.add(value.slice(i, i + size));
  return [...out];
}

function fixture(): FakeGitHub {
  return new FakeGitHub({
    owner: "acme",
    installationId: INSTALLATION_ID,
    token: INSTALLATION_TOKEN,
    repos: [
      {
        id: HANDBOOK_ID,
        name: "handbook",
        files: {
          "README.md": "# Handbook\n",
          "docs/start.md": "# Start\n\n![arch](img/arch.png)\n",
          "docs/img/arch.png": PNG,
        },
      },
      { id: METRICS_ID, name: "metrics", files: { "docs/a.md": "# A\n" } },
    ],
  });
}

describeDb("no credential reaches the logs (task 12.4)", () => {
  vi.setConfig({ testTimeout: 120_000 });
  let testDb: TestDatabase;
  let h: DbHandle;
  let fake: FakeGitHub;
  let output: CapturedOutput;
  /** App JWTs the token provider sent: generated at run time, so collected from the requests. */
  const jwts: string[] = [];
  /** Request headers and bodies, which may hold credentials and must never be logged. */
  const fetchWithCapture: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== null && /access_tokens$/.test(new URL(url).pathname)) {
      jwts.push(auth.replace(/^bearer /i, ""));
    }
    return fake.fetch(input, init);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    h = createDb(testDb.url.reveal(), { max: 10 });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await h.db.execute(
      sql`TRUNCATE repos, sync_runs, workspace_settings, workspace_secrets, settings_audit RESTART IDENTITY CASCADE`,
    );
    await configure();
    fake = fixture();
    jwts.length = 0;
    output = captureOutput("debug");
  });

  afterEach(() => {
    output.restore();
    resetWorkspaceCache();
  });

  /** Saves the GitHub App settings and secrets, as the admin interface does. */
  async function configure() {
    const result = await saveWorkspace(h.db, KEY, {
      userId: null,
      expectedVersion: await readVersion(h.db),
      settings: {
        github: { appId: 12345, installationId: INSTALLATION_ID },
        repos: ["handbook", "metrics"],
      },
      secrets: { github_private_key: PEM, github_webhook_secret: WEBHOOK_SECRET },
    });
    expect(result.ok).toBe(true);
  }

  /** GitHub parts over the shared test pool (do not close it: that would end the pool). */
  async function github(): Promise<GitHubParts> {
    return requireGitHub(await createWorkspace({ handle: h, env: ENV, fetch: fetchWithCapture }));
  }

  const webhookSecret = async () => ({
    webhookSecret: (await createWorkspace({ handle: h, env: ENV, fetch: fetchWithCapture }))
      .webhookSecret,
  });

  async function manualSync(
    body: string | undefined,
    authorization: string | null = `Bearer ${SYNC_SECRET}`,
    getService = () => {
      // Each call starts from a freshly built workspace, so a failure injected for one call is
      // not absorbed by a token cached from the previous one.
      resetWorkspaceCache();
      return getSyncService({ env: ENV, fetch: fetchWithCapture, handle: h });
    },
  ): Promise<string> {
    const headers: Record<string, string> = authorization === null ? {} : { authorization };
    const response = await handleManualSync(
      new Request("http://localhost/api/sync", { method: "POST", headers, body }),
      { readSecret: () => readConfiguredSyncSecret(ENV), getService },
    );
    return `${response.status} ${await response.text()}`;
  }

  function webhookRequest(body: string, secret = WEBHOOK_SECRET, event = "push"): Request {
    return new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
  }

  function pushBody(id = HANDBOOK_ID, name = "handbook"): string {
    return JSON.stringify({
      ref: "refs/heads/main",
      repository: { id, name, default_branch: "main", archived: false },
      installation: { id: INSTALLATION_ID },
    });
  }

  async function serveImage(rt: GitHubParts, path = "acme/handbook/docs/img/arch.png") {
    return serveAsset({ method: "GET", headers: new Headers() }, path.split("/"), () => ({
      findRepo: (owner, name) => findAssetRepo(h.db, owner, name),
      isConfigured: (name) => repoNameSelection(rt.sync.config, name) === "selected",
      github: rt.assets,
    }));
  }

  /** The core assertion: nothing printed holds a sentinel or a piece of one. */
  function expectNoSentinel(): void {
    const printed = output.text();
    const sentinels: [string, string][] = [
      ["installation token", INSTALLATION_TOKEN],
      ["webhook secret", WEBHOOK_SECRET],
      ["sync secret", SYNC_SECRET],
      ["session secret", SESSION_SECRET],
      ["database password", DB_PASSWORD],
      ["private key body", KEY_BODY],
      ["encryption key", ENCRYPTION_KEY],
      ["provider API key", ANTHROPIC_KEY],
      ...jwts.map((jwt, i): [string, string] => [`app JWT ${i}`, jwt]),
    ];
    for (const [label, value] of sentinels) {
      for (const piece of pieces(value)) {
        if (printed.includes(piece)) {
          throw new Error(`${label}: the piece ${JSON.stringify(piece)} was logged`);
        }
      }
    }
    expect(printed).not.toContain("BEGIN");
    expect(printed).not.toMatch(/bearer/i);
    // Every line is a structured JSON line; nothing went to the console raw.
    for (const line of printed.split("\n").filter((l) => l !== "")) {
      expect(line.startsWith('{"ts":"'), line.slice(0, 80)).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }

  const events = () => output.records().map((r) => r.event);

  it("success paths: token mint, /api/sync full and single, webhook push, image proxy", async () => {
    expect(await manualSync(undefined)).toMatch(/^200 /);
    expect(await manualSync('{"repo":"metrics"}')).toMatch(/^200 /);

    const rt = await github();
    const tasks = createBackgroundTasks();
    const dispatch = createWebhookDispatch({
      sync: rt.sync,
      installationId: INSTALLATION_ID,
      tasks,
    });
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nPushed.\n");
    const pushed = await handleWebhookRequest(webhookRequest(pushBody()), {
      readSecret: () => readConfiguredWebhookSecret(webhookSecret),
      dispatch,
    });
    expect(pushed.status).toBe(202);
    await tasks.idle();

    const image = await serveImage(rt);
    expect(image.status).toBe(200);
    expect((await serveImage(rt, "acme/handbook/docs/img/missing.png")).status).toBe(404);

    expect(jwts.length).toBeGreaterThan(0);
    expectNoSentinel();
    for (const event of [
      "github.token.minted",
      "sync_api.auth",
      "sync.run.started",
      "sync.discovery.done",
      "sync.repo.done",
      "sync.run.finished",
      "sync_api.done",
      "webhook.received",
      "webhook.decision",
      "webhook.dispatch",
      "sync.request.done",
      "webhook.task.finished",
      "asset.served",
    ]) {
      expect(events()).toContain(event);
    }
    const finished = output.records().find((r) => r.event === "sync.run.finished");
    expect(finished).toMatchObject({ trigger: "manual", scopeKind: "all", status: "success" });
    expect(output.records().find((r) => r.event === "github.token.minted")).toMatchObject({
      installationId: INSTALLATION_ID,
      expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
  });

  it("failure paths: rate limit, 401, installation gone, bad App credentials, DB error, bad signatures, bad auth", async () => {
    // Unauthorized /api/sync, including a near miss that contains the real secret.
    for (const authorization of [null, `Bearer ${SYNC_SECRET}x`, `Basic ${SYNC_SECRET}`]) {
      expect(await manualSync(undefined, authorization)).toMatch(/^401 /);
    }

    // A first sync stores the repos, so later failures mark rows.
    expect(await manualSync(undefined)).toMatch(/^200 /);

    // Rate limit beyond the client's wait.
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nChanged.\n");
    fake.fail({
      path: /\/branches\//,
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
      times: 1,
    });
    expect(await manualSync(undefined)).toMatch(/^503 /);

    // 401 from the API twice: the token is refreshed once, then the run fails unauthorized.
    fake.fail({ path: /\/branches\//, status: 401, times: 2 });
    await manualSync(undefined);

    // GitHub rejects the App credentials when minting.
    fake.fail({ path: /access_tokens$/, status: 401, times: 1 });
    await manualSync(undefined);

    // The installation is gone: minting and the listing answer 404.
    fake.installationGone = true;
    await manualSync(undefined);
    await manualSync('{"repo":"handbook"}');
    fake.installationGone = false;

    // An image fetch that hits a rate limit.
    const rt = await github();
    fake.fail({ path: /\/contents\//, status: 429, headers: { "retry-after": "30" }, times: 1 });
    expect((await serveImage(rt)).status).toBe(503);

    // An unreachable database whose URL carries the password; and a raw error with credentials.
    const dead = createDb(`postgres://app:${DB_PASSWORD}@127.0.0.1:1/docmyrepos`, {
      connectTimeoutMs: 1_000,
    });
    try {
      expect(
        await manualSync(undefined, `Bearer ${SYNC_SECRET}`, () => {
          resetWorkspaceCache();
          return getSyncService({ env: ENV, fetch: fetchWithCapture, handle: dead });
        }),
      ).toMatch(/^500 /);
    } finally {
      await dead.close();
    }
    expect(
      await manualSync(undefined, `Bearer ${SYNC_SECRET}`, async () => ({
        syncAll: async () => {
          throw new Error(
            `connect postgres://app:${DB_PASSWORD}@db/x token ${INSTALLATION_TOKEN} key ${KEY_BODY.slice(0, 64)}`,
          );
        },
        syncOne: async () => ({ status: "busy" }),
      })),
    ).toMatch(/^500 /);

    // GitHub settings that are not (yet) complete: the answer names nothing but setting names.
    await h.db.execute(sql`TRUNCATE workspace_settings, workspace_secrets RESTART IDENTITY`);
    expect(await manualSync(undefined)).toMatch(/^500 /);
    await configure();

    // Webhooks: a wrong secret, a signature of another body, a dispatch that throws credentials.
    const tasks = createBackgroundTasks();
    const deps = {
      readSecret: () => readConfiguredWebhookSecret(webhookSecret),
      dispatch: createWebhookDispatch({ sync: rt.sync, installationId: INSTALLATION_ID, tasks }),
    };
    expect(
      (await handleWebhookRequest(webhookRequest(pushBody(), `${WEBHOOK_SECRET}-wrong`), deps))
        .status,
    ).toBe(401);
    const forged = webhookRequest(pushBody());
    const tampered = new Request(forged.url, {
      method: "POST",
      headers: forged.headers,
      body: pushBody(METRICS_ID, "metrics"),
    });
    expect((await handleWebhookRequest(tampered, deps)).status).toBe(401);
    const throwing = await handleWebhookRequest(webhookRequest(pushBody()), {
      ...deps,
      dispatch: async () => {
        throw new Error(`token ${INSTALLATION_TOKEN} secret ${WEBHOOK_SECRET}`);
      },
    });
    expect(throwing.status).toBe(500);
    // A webhook sync that fails in the background (rate limit on the listing).
    fake.fail({
      path: "/installation/repositories",
      status: 429,
      headers: { "retry-after": "999" },
    });
    expect((await handleWebhookRequest(webhookRequest(pushBody()), deps)).status).toBe(202);
    await tasks.idle();
    fake.clearFailures();

    expect(jwts.length).toBeGreaterThan(0);
    expectNoSentinel();
    for (const event of [
      "sync_api.auth",
      "github.rate_limit.exceeded",
      "github.token.rejected",
      "github.token.mint_failed",
      "github.installation.unavailable",
      "sync.discovery.failed",
      "sync.run.finished",
      "sync_api.failed",
      "sync_api.not_configured",
      "webhook.signature",
      "webhook.dispatch_failed",
      "asset.upstream_failed",
    ]) {
      expect(events()).toContain(event);
    }
    expect(output.records().filter((r) => r.event === "sync_api.auth")).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "unauthorized", level: "warn" })]),
    );
  });

  it("settings paths: saving, refusing, testing and replacing secrets never log a secret", async () => {
    const admin = async () => ({ id: 0, email: "admin@example.com", role: "admin" as const });
    const deps = {
      db: h.db,
      admin,
      encryptionKey: () => KEY,
      githubTest: { fetch: fetchWithCapture },
      problems: async () => ({
        missingGithub: [],
        encryptionKey: null,
        unreadable: [],
        invalidStored: false,
      }),
    };
    const put = (path: string, body: unknown) =>
      new Request(`http://localhost${path}`, {
        method: path.endsWith("test") ? "POST" : "PUT",
        headers: { "content-type": "application/json", host: "localhost" },
        body: JSON.stringify(body),
      });
    const version = () => readVersion(h.db);

    // A valid save, a refused one (bad key text that holds a sentinel), a stale one, and credentials.
    const ok = await handleSaveSettings(
      put("/api/admin/settings", {
        expectedVersion: await version(),
        secrets: { github_webhook_secret: WEBHOOK_SECRET },
      }),
      deps,
    );
    expect(ok.status, JSON.stringify(output.records().filter((r) => /failed/.test(r.event)))).toBe(
      200,
    );
    const refused = await handleSaveSettings(
      put("/api/admin/settings", {
        expectedVersion: await version(),
        secrets: {
          github_private_key: `not a key ${INSTALLATION_TOKEN}`,
          anthropic_api_key: ANTHROPIC_KEY + " x",
        },
      }),
      deps,
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(INSTALLATION_TOKEN);
    const stale = await handleSaveSettings(
      put("/api/admin/settings", {
        expectedVersion: 1,
        secrets: { anthropic_api_key: ANTHROPIC_KEY },
      }),
      deps,
    );
    expect(stale.status).toBe(409);
    const creds = await handleSaveProviderCredentials(
      put("/api/admin/ask/credentials", {
        expectedVersion: await version(),
        secrets: { anthropic_api_key: ANTHROPIC_KEY },
      }),
      deps,
    );
    expect(creds.status).toBe(200);
    expect(await creds.text()).not.toContain(ANTHROPIC_KEY);

    // A GitHub test with submitted values, and with the stored ones.
    const submitted = await handleTestGithub(
      put("/api/admin/settings/test", {
        appId: 12345,
        installationId: INSTALLATION_ID,
        privateKey: PEM,
      }),
      deps,
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({ result: "ok" });
    const stored = await handleTestGithub(put("/api/admin/settings/test", {}), {
      ...deps,
      testLimiter: undefined,
    });
    expect([200, 429]).toContain(stored.status);

    expectNoSentinel();
    expect(events()).toContain("settings.changed");
    expect(events()).toContain("settings.save_refused");
    const changed = output.records().filter((r) => r.event === "settings.changed");
    expect(JSON.stringify(changed)).toContain("secret:anthropic_api_key");
  });

  it("negative control: the check fails when a call site logs a credential under an innocent key", () => {
    logger.info("test.leak", { note: `value ${INSTALLATION_TOKEN.slice(3, 15)}` });
    expect(() => expectNoSentinel()).toThrow(/installation token: the piece/);
  });
});
