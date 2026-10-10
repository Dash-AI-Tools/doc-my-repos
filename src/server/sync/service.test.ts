import { generateKeyPairSync } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { withRepoSyncLock } from "../db/advisory-lock";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { FakeGitHub } from "./fake-github";
import { handleManualSync } from "./manual-sync";
import { getSyncService, readConfiguredSyncSecret } from "./service";
import { captureOutput } from "../test-logger";

// The real handler, service, runtime reload, engine and client, over a fake GitHub and a real
// test database.

const SECRET = "SENTINEL-sync-secret-4f9a1c7e";
const TOKEN = "ghs_SENTINELserviceToken";
const DB_PASSWORD = "SENTINELdbPassw0rd";
const CONFIG_FILE = "/etc/docmyrepos.yml";

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_LINE = PEM.split("\n")[3] as string;

const HANDBOOK_ID = 101;
const METRICS_ID = 202;

function fixture(): FakeGitHub {
  return new FakeGitHub({
    owner: "acme",
    installationId: 4242,
    token: TOKEN,
    repos: [
      {
        id: HANDBOOK_ID,
        name: "handbook",
        files: { "README.md": "# Handbook\n", "docs/start.md": "# Start\n\nHello.\n" },
      },
      {
        id: METRICS_ID,
        name: "metrics",
        files: {
          "docs/index.md": "---\nokf_version: '0.2'\n---\n# Metrics\n",
          "docs/a.md": "# A\n",
        },
      },
    ],
  });
}

describeDb("POST /api/sync against a fixture-backed fake GitHub and a real database", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;
  let fake: FakeGitHub;
  let configYaml: string;
  let createDbCalls: number;
  const responses: string[] = [];

  const env = {
    DATABASE_URL: `postgres://app:${DB_PASSWORD}@db.invalid:5432/docmyrepos`,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_INSTALLATION_ID: "4242",
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_WEBHOOK_SECRET: "SENTINELwebhookSecret",
    SYNC_SECRET: SECRET,
    CONFIG_PATH: CONFIG_FILE,
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
    await h.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
    fake = fixture();
    configYaml = "repos:\n  - handbook\n  - metrics\n";
    createDbCalls = 0;
    responses.length = 0;
  });

  afterEach(() => {
    // The shared runtime points at the test pool; never leave it behind.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("docmyrepos.runtime")];
  });

  function post(body?: string, authorization: string | null = `Bearer ${SECRET}`) {
    const headers: Record<string, string> = authorization === null ? {} : { authorization };
    return new Request("http://localhost/api/sync", { method: "POST", headers, body });
  }

  async function call(request: Request) {
    const response = await handleManualSync(request, {
      readSecret: () => readConfiguredSyncSecret(env),
      getService: () =>
        getSyncService({
          env,
          readFile: (path) => {
            if (path !== CONFIG_FILE) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            return configYaml;
          },
          fetch: fake.fetch,
          createDb: () => (createDbCalls++, h),
        }),
    });
    const text = await response.text();
    responses.push(text);
    return { response, json: JSON.parse(text) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  const runs = () => h.db.select().from(syncRuns).orderBy(syncRuns.id);
  const repoCount = async () => (await h.db.select({ id: repos.id }).from(repos)).length;
  const docCount = async () => (await h.db.select({ id: documents.id }).from(documents)).length;

  afterEach(() => {
    const printed = responses.join("\n");
    for (const secret of [SECRET, TOKEN, DB_PASSWORD, PEM_LINE]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("syncs every repository for an authorized request and records a manual run", async () => {
    const { response, json } = await call(post());
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, scope: "all", run: { status: "success" } });
    expect(
      json.repositories.map((r: { repo: string; status: string }) => [r.repo, r.status]),
    ).toEqual([
      ["acme/handbook", "ok"],
      ["acme/metrics", "ok"],
    ]);
    expect(await repoCount()).toBe(2);
    expect(await docCount()).toBeGreaterThanOrEqual(3);
    const [run] = await runs();
    expect(run).toMatchObject({ trigger: "manual", scope: null, status: "success" });
    expect(run?.finishedAt).not.toBeNull();

    // A second call finds nothing changed.
    const again = await call(post());
    expect(again.json.repositories.map((r: { status: string }) => r.status)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("syncs one repository by name, by owner/name and by id", async () => {
    const byName = await call(post('{"repo":"metrics"}'));
    expect(byName.response.status).toBe(200);
    expect(byName.json.scope).toBe("repo");
    expect(byName.json.repositories).toMatchObject([{ repo: "acme/metrics", status: "ok" }]);

    const byOwner = await call(post('{"repo":"ACME/Handbook"}'));
    expect(byOwner.response.status).toBe(200);
    const byId = await call(post(`{"githubId":${HANDBOOK_ID}}`));
    expect(byId.response.status).toBe(200);
    expect(byId.json.repositories).toMatchObject([{ status: "unchanged" }]);

    expect((await runs()).map((r) => [r.trigger, r.scope, r.status])).toEqual([
      ["manual", "acme/metrics", "success"],
      ["manual", "acme/handbook", "success"],
      ["manual", "acme/handbook", "success"],
    ]);
  });

  it("answers 404 for an unknown or unselected repository without starting a run", async () => {
    configYaml = "";
    const unknown = await call(post('{"repo":"nope"}'));
    expect(unknown.response.status).toBe(404);
    expect(unknown.json.error).toBe("repository_not_found");
    configYaml = "repos:\n  - handbook\n";
    const unselected = await call(post('{"repo":"metrics"}'));
    expect(unselected.response.status).toBe(404);
    expect(unselected.json).toMatchObject({
      error: "repository_not_configured",
      reason: "not_listed",
    });
    expect((await call(post('{"githubId":999}'))).response.status).toBe(404);
    expect(await runs()).toEqual([]);
    expect(await repoCount()).toBe(0);
  });

  it("does nothing at all for an unauthorized request", async () => {
    for (const authorization of [null, "Bearer wrong-wrong-wrong-wrong", `Basic ${SECRET}`]) {
      const { response, json } = await call(post(undefined, authorization));
      expect(response.status).toBe(401);
      expect(json).toEqual({ error: "unauthorized" });
    }
    const bad = await call(post('{"repo":"handbook"}', "Bearer nope-nope-nope-nope"));
    expect(bad.response.status).toBe(401);
    expect(fake.requests).toEqual([]);
    expect(createDbCalls).toBe(0);
    expect(await runs()).toEqual([]);
    expect(await repoCount()).toBe(0);
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for("docmyrepos.runtime")],
    ).toBeUndefined();
  });

  it("re-reads the config on every request and reuses the database handle", async () => {
    configYaml = "repos:\n  - handbook\n";
    const first = await call(post());
    expect(first.json.repositories).toMatchObject([{ repo: "acme/handbook" }]);
    expect(await repoCount()).toBe(1);

    configYaml = "repos:\n  - handbook\n  - metrics\n";
    const second = await call(post());
    expect(second.json.repositories.map((r: { repo: string }) => r.repo)).toEqual([
      "acme/handbook",
      "acme/metrics",
    ]);
    expect(await repoCount()).toBe(2);

    // Dropping a repository from the file removes it on the next call.
    configYaml = "repos:\n  - metrics\n";
    const third = await call(post());
    expect(third.response.status).toBe(200);
    expect(third.json.repositories).toContainEqual(
      expect.objectContaining({ repo: "acme/handbook", status: "removed" }),
    );
    expect(await repoCount()).toBe(1);
    // The pool was never closed: the handle still answers.
    await h.db.execute(sql`select 1`);
  });

  it("answers 500 with a fixed body for an invalid config file and keeps working after a fix", async () => {
    configYaml = "reposs: SENTINELfileText\n";
    const output = captureOutput();
    try {
      const bad = await call(post());
      expect(bad.response.status).toBe(500);
      expect(bad.json).toMatchObject({ error: "misconfigured" });
      expect(responses.at(-1)).not.toContain("SENTINELfileText");
      expect(responses.at(-1)).not.toContain("reposs");
      const logged = output.text();
      expect(output.records().map((r) => r.event)).toContain("sync_api.config_invalid");
      expect(logged).not.toContain("SENTINELfileText");
      for (const secret of [SECRET, TOKEN, DB_PASSWORD, PEM_LINE]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      output.restore();
    }
    expect(fake.requests).toEqual([]);
    configYaml = "repos:\n  - handbook\n";
    expect((await call(post())).response.status).toBe(200);
  });

  it("answers 409 for a never-synced repository whose lock is held elsewhere (nothing recorded)", async () => {
    const held = await withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, async () => ({
      one: await call(post('{"repo":"handbook"}')),
      all: await call(post()),
    }));
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    expect(held.value.one.response.status).toBe(409);
    expect(held.value.one.json).toMatchObject({ ok: false, error: "repository_busy" });
    expect(held.value.all.response.status).toBe(200);
    expect(
      held.value.all.json.repositories.map((r: { repo: string; status: string }) => [
        r.repo,
        r.status,
      ]),
    ).toEqual([
      ["acme/handbook", "skipped"],
      ["acme/metrics", "ok"],
    ]);
  });

  it("answers 202 coalesced while another sync holds a stored repository, and the request survives", async () => {
    await call(post());
    const requested = async () =>
      (
        await h.db.execute<{ github_id: string }>(
          sql`select github_id from repos where sync_requested_at is not null order by github_id`,
        )
      ).rows.map((r) => Number(r.github_id));

    const held = await withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, async () => {
      const one = await call(post('{"repo":"handbook"}'));
      const marked = await requested();
      const all = await call(post());
      return { one, marked, all };
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    expect(held.value.one.response.status).toBe(202);
    expect(held.value.one.json).toMatchObject({ ok: true, status: "coalesced" });
    expect(held.value.marked).toEqual([HANDBOOK_ID]);
    // Only one repository busy: 200, the busy one skipped, its request still recorded.
    expect(held.value.all.response.status).toBe(200);
    expect(
      held.value.all.json.repositories.map((r: { repo: string; status: string }) => [
        r.repo,
        r.status,
      ]),
    ).toEqual([
      ["acme/handbook", "skipped"],
      ["acme/metrics", "unchanged"],
    ]);
    expect(await requested()).toEqual([HANDBOOK_ID]);

    // The next full sync covers it and clears the marker.
    expect((await call(post())).response.status).toBe(200);
    expect(await requested()).toEqual([]);
  });

  it("answers 503 when the installation is unavailable and keeps stored content", async () => {
    await call(post());
    const docsBefore = await docCount();
    fake.fail({ path: "/installation/repositories", status: 404 });
    const all = await call(post());
    expect(all.response.status).toBe(503);
    expect(all.json).toMatchObject({ ok: false, error: { kind: "installation_unavailable" } });
    expect(await docCount()).toBe(docsBefore);

    const one = await call(post('{"repo":"handbook"}'));
    expect(one.response.status).toBe(503);
    expect(one.json).toMatchObject({ ok: false, scope: "repo" });
    expect(await docCount()).toBe(docsBefore);
    expect((await runs()).map((r) => r.status)).toEqual(["success", "failed", "failed"]);
  });
});
