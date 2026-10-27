import { createHmac, generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Job } from "@docmyrepos/server";

import { FakeGitHub } from "../support/fake-github";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * A host's queue receives the core's background work as jobs, and its worker runs them with
 * `app.jobs.run`: the scheduler's startup work for every tenant and a webhook's dispatch each run
 * against the tenant they name, and duplicate repository syncs leave the state of one sync.
 */
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const WEBHOOK_SECRET = "contract-webhook-secret-tenant-a-0123";
const HANDBOOK = 101;

let t: TwoTenants;
let github: FakeGitHub;
let host: ReturnType<TwoTenants["app"]>;
const queue: Job[] = [];

/** Runs every queued job, as a host's worker does, and empties the queue. */
async function work(): Promise<string[]> {
  const jobs = queue.splice(0);
  for (const job of jobs) await host.jobs.run(job);
  return jobs.map((job) => `${job.payload.tenantId}:${job.name}`);
}

const documentsOf = async (tenant: "a" | "b") =>
  (await t.sql<{ path: string }>(tenant, "select path from documents order by path")).map(
    (row) => row.path,
  );

beforeAll(async () => {
  t = await twoTenants();
  github = new FakeGitHub({
    owner: "acme",
    repos: [{ id: HANDBOOK, name: "handbook", files: { "docs/keys.md": "# Keys\n" } }],
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith("https://api.github.com")
      ? github.fetch(input, init)
      : realFetch(input, init),
  );
  host = t.app({
    config: { SYNC_SCHEDULER: "1" },
    adapters: {
      jobs: {
        submit: async (job) => {
          queue.push(job);
          return {};
        },
      },
    },
  });

  // Tenant a has GitHub set up through the admin API; tenant b has not.
  const [admin] = await t.sql<{ id: number }>(
    "a",
    "INSERT INTO users (email, password_hash, role) VALUES ('root@a.example', 'x', 'admin') RETURNING id",
  );
  const ctx = await host.context(t.request("/", "a"));
  const cookie = (await host.issueSession(ctx!, admin!.id, { secure: false })).split(";")[0]!;
  const view = await (
    await host.routes.adminSettings.GET(
      t.request("/api/admin/settings", "a", { headers: { cookie } }),
    )
  ).json();
  const saved = await host.routes.adminSettings.PUT(
    t.request("/api/admin/settings", "a", {
      method: "PUT",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: view.version,
        settings: { ...view.settings, github: { appId: 1, installationId: github.installationId } },
        secrets: { github_private_key: PEM, github_webhook_secret: WEBHOOK_SECRET },
      }),
    }),
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await t?.close();
});

describe("a queue jobs adapter", () => {
  it("receives the scheduler's startup work for every tenant, and its worker runs it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      await host.start();
      // The startup work comes after the scheduler's startup delay (10 s).
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() =>
        expect(queue.filter((job) => job.name === "sync.full")).toHaveLength(2),
      );
    } finally {
      vi.useRealTimers();
    }
    expect(await work()).toEqual(
      expect.arrayContaining(["a:sync.reap", "a:sync.full", "b:sync.reap", "b:sync.full"]),
    );
    // The sync landed in tenant a's database; tenant b has no GitHub settings, so nothing ran.
    expect(await documentsOf("a")).toEqual(["docs/keys.md"]);
    expect(await documentsOf("b")).toEqual([]);
  }, 30_000);

  it("receives a verified webhook's dispatch, answered 202 at once, for the right tenant", async () => {
    github.setFile(HANDBOOK, "docs/rotate.md", "# Rotate\n");
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { id: HANDBOOK, name: "handbook", default_branch: "main" },
      installation: { id: github.installationId },
    });
    const response = await host.routes.githubWebhook.POST(
      t.request("/api/webhooks/github", "a", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
        },
        body,
      }),
    );
    expect(response.status).toBe(202);
    expect(await work()).toEqual(["a:webhook.dispatch"]);
    // The router starts the repository's sync in the background of the worker.
    await vi.waitFor(
      async () => expect(await documentsOf("a")).toEqual(["docs/keys.md", "docs/rotate.md"]),
      { timeout: 10_000 },
    );
    expect(await documentsOf("b")).toEqual([]);
  });

  it("leaves the state of one sync when the same repository sync runs twice at once", async () => {
    github.setFile(HANDBOOK, "docs/audit.md", "# Audit\n");
    github.deleteFile(HANDBOOK, "docs/keys.md");
    const job: Job = {
      name: "sync.repo",
      payload: { tenantId: "a", githubId: HANDBOOK, trigger: "webhook" },
    };
    await Promise.all([host.jobs.run(job), host.jobs.run(job)]);
    // A job that finds the repository syncing coalesces: the sync holding it reruns, so the
    // stored state settles once that rerun ends.
    await vi.waitFor(
      async () => expect(await documentsOf("a")).toEqual(["docs/audit.md", "docs/rotate.md"]),
      { timeout: 15_000, interval: 100 },
    );
    const [counts] = await t.sql<{ n: string; distinct_paths: string }>(
      "a",
      "select count(*) as n, count(distinct path) as distinct_paths from documents",
    );
    expect(counts).toEqual({ n: "2", distinct_paths: "2" });
  });
});
