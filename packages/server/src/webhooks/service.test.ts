import { createHmac } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Secret } from "../config/secret";
import { configSchema } from "@docmyrepos/core/internal/config/schema";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { createLogger } from "../log";
import { renderRecord } from "../test-logger";
import { createSyncContext, syncAll, type SyncContext } from "../sync/engine";
import { FakeGitHub } from "../../../../tests/support/fake-github";
import { handleWebhookRequest, type WebhookDispatch } from "./endpoint";
import {
  INSTALLATION_UNAVAILABLE_MESSAGES,
  createBackgroundTasks,
  type BackgroundTasks,
} from "./router";
import { createWebhookDispatch, readConfiguredWebhookSecret, webhookTasks } from "./service";

describe("readConfiguredWebhookSecret", () => {
  it("returns the stored secret", async () => {
    const load = async () => ({ webhookSecret: new Secret("SENTINEL-webhook-0123") });
    expect(await readConfiguredWebhookSecret(load)).toBe("SENTINEL-webhook-0123");
  });

  it("returns null when none is stored, and when the settings cannot be loaded", async () => {
    expect(await readConfiguredWebhookSecret(async () => ({ webhookSecret: null }))).toBeNull();
    expect(
      await readConfiguredWebhookSecret(async () => {
        throw new Error("database down");
      }),
    ).toBeNull();
  });
});

describe("webhookTasks", () => {
  it("shares one background task tracker per process", () => {
    expect(webhookTasks()).toBe(webhookTasks());
  });
});

// ---------------------------------------------------------------------------------------------
// The real router, engine and client over a fake GitHub and a real test database.

const INSTALLATION = 4242;
const TOKEN = "ghs_SENTINELwebhookToken";
const SECRET = "SENTINEL-webhook-secret-3b8e5a";
const HANDBOOK_ID = 101;
const METRICS_ID = 202;
const SANDBOX_ID = 303;

function fixture(): FakeGitHub {
  return new FakeGitHub({
    owner: "acme",
    installationId: INSTALLATION,
    token: TOKEN,
    repos: [
      {
        id: HANDBOOK_ID,
        name: "handbook",
        visibility: "public",
        files: { "README.md": "# Handbook\n", "docs/start.md": "# Start\n\nHello.\n" },
      },
      {
        id: METRICS_ID,
        name: "metrics",
        visibility: "private",
        files: { "docs/a.md": "# A\n", "docs/b.md": "# B\n" },
      },
      { id: SANDBOX_ID, name: "sandbox", files: { "docs/s.md": "# S\n" } },
    ],
  });
}

describeDb("webhook router wired to the sync engine", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;
  let fake: FakeGitHub;
  let ctx: SyncContext;
  let tasks: BackgroundTasks;
  let dispatch: WebhookDispatch;
  // Every log line (router, endpoint, engine, GitHub client) as `event key=value ...`.
  const logged: string[] = [];
  const log = createLogger({
    level: "debug",
    write: (line) => logged.push(renderRecord(JSON.parse(line) as Record<string, unknown>)),
  });

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
    ctx = createSyncContext({
      db: h.db,
      pool: h.pool,
      github: createGitHubClient({
        getToken: fake.getToken,
        fetch: fake.fetch,
        sleep: async () => undefined,
        maxWaitMs: 1_000,
      }),
      config: configSchema.parse({ exclude: ["sandbox"] }),
      log,
    });
    tasks = createBackgroundTasks();
    logged.length = 0;
    dispatch = createWebhookDispatch({
      sync: ctx,
      installationId: INSTALLATION,
      tasks,
      log,
      removalLockWaitMs: 5_000,
    });
    const initial = await syncAll(ctx, { trigger: "manual" });
    expect(initial.fatal).toBeNull();
  });

  async function send(event: string, payload: Record<string, unknown>) {
    await dispatch(event, payload, "delivery-1");
    await tasks.idle();
  }

  async function repoRow(githubId: number) {
    const [row] = await h.db.select().from(repos).where(eq(repos.githubId, githubId));
    return row;
  }

  async function docsOf(githubId: number) {
    return h.db
      .select({ path: documents.path, body: documents.body })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(eq(repos.githubId, githubId))
      .orderBy(asc(documents.path));
  }

  async function documentCount() {
    const rows = await h.db.select({ id: documents.id }).from(documents);
    return rows.length;
  }

  function repository(id: number, name: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name,
      full_name: `acme/${name}`,
      default_branch: "main",
      archived: false,
      ...extra,
    };
  }

  function pushPayload(id: number, name: string, ref = "refs/heads/main") {
    return {
      ref,
      deleted: false,
      repository: repository(id, name),
      installation: { id: INSTALLATION },
    };
  }

  it("re-syncs a repository after a signed push to its default branch", async () => {
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nUpdated by a push.\n");
    const body = JSON.stringify(pushPayload(HANDBOOK_ID, "handbook"));
    const response = await handleWebhookRequest(
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
          "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
        },
        body,
      }),
      { readSecret: () => SECRET, dispatch, log },
    );
    expect(response.status).toBe(202);
    await tasks.idle();

    expect((await docsOf(HANDBOOK_ID)).find((d) => d.path === "docs/start.md")?.body).toContain(
      "Updated by a push.",
    );
    const runs = await h.db.select().from(syncRuns).orderBy(asc(syncRuns.id));
    expect(runs.at(-1)).toMatchObject({
      trigger: "webhook",
      scope: "acme/handbook",
      status: "success",
    });
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("does not sync for a push to another branch", async () => {
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nOn a branch.\n");
    const before = await h.db.select().from(syncRuns);
    await send("push", pushPayload(HANDBOOK_ID, "handbook", "refs/heads/feature"));
    expect(await h.db.select().from(syncRuns)).toHaveLength(before.length);
    expect((await docsOf(HANDBOOK_ID)).find((d) => d.path === "docs/start.md")?.body).not.toContain(
      "On a branch.",
    );
  });

  it("removes a deleted repository and does not resurrect it on a late push", async () => {
    expect(await docsOf(HANDBOOK_ID)).not.toHaveLength(0);
    fake.removeRepo(HANDBOOK_ID);
    await send("repository", {
      action: "deleted",
      repository: repository(HANDBOOK_ID, "handbook"),
      installation: { id: INSTALLATION },
    });
    expect(await repoRow(HANDBOOK_ID)).toBeUndefined();
    expect(await docsOf(HANDBOOK_ID)).toHaveLength(0);
    expect(await repoRow(METRICS_ID)).toBeDefined();

    // A push delivered after the deletion (GitHub does not guarantee ordering).
    await send("push", pushPayload(HANDBOOK_ID, "handbook"));
    expect(await repoRow(HANDBOOK_ID)).toBeUndefined();
    expect(logged).toContain(
      `webhook.task.finished githubEvent=push action=- deliveryId=delivery-1 task=sync githubId=${HANDBOOK_ID} status=not_found`,
    );
  });

  it("removes repositories removed from the installation and syncs added ones", async () => {
    fake.removeRepo(METRICS_ID);
    await send("installation_repositories", {
      action: "removed",
      installation: { id: INSTALLATION },
      repository_selection: "selected",
      repositories_removed: [{ id: METRICS_ID, name: "metrics" }],
    });
    expect(await repoRow(METRICS_ID)).toBeUndefined();

    fake.addRepo({ id: 505, name: "guides", files: { "docs/g.md": "# G\n" } });
    await send("installation_repositories", {
      action: "added",
      installation: { id: INSTALLATION },
      repository_selection: "selected",
      repositories_added: [{ id: 505, name: "guides" }],
    });
    expect(await docsOf(505)).toEqual([
      { path: "docs/g.md", body: expect.stringContaining("# G") },
    ]);
  });

  it("makes a privatized repository private as soon as the dispatch resolves", async () => {
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("public");
    fake.updateRepo(HANDBOOK_ID, { visibility: "private" });
    // Hold every GitHub request, so the follow-up sync cannot be what made the row private.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.onRequest = () => gate;
    await dispatch(
      "repository",
      {
        action: "privatized",
        repository: repository(HANDBOOK_ID, "handbook"),
        installation: { id: INSTALLATION },
      },
      "delivery-1",
    );
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("private");
    expect(tasks.size).toBe(1);
    release();
    await tasks.idle();
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("private");
  });

  it("marks every repository errored on suspend, keeps content, and recovers on unsuspend", async () => {
    const docsBefore = await documentCount();
    expect(docsBefore).toBeGreaterThan(0);

    fake.installationGone = true;
    await send("installation", { action: "suspend", installation: { id: INSTALLATION } });
    const suspended = await h.db.select().from(repos).orderBy(asc(repos.githubId));
    expect(suspended.map((r) => r.githubId)).toEqual([HANDBOOK_ID, METRICS_ID]);
    for (const row of suspended) {
      expect(row.syncStatus).toBe("error");
      expect(row.syncError).toBe(INSTALLATION_UNAVAILABLE_MESSAGES.suspend);
    }
    expect(await documentCount()).toBe(docsBefore);

    // A push while suspended fails its listing and still deletes nothing.
    await send("push", pushPayload(HANDBOOK_ID, "handbook"));
    expect(await documentCount()).toBe(docsBefore);

    fake.installationGone = false;
    await send("installation", { action: "unsuspend", installation: { id: INSTALLATION } });
    const recovered = await h.db.select().from(repos).orderBy(asc(repos.githubId));
    for (const row of recovered) {
      expect(row.syncStatus).toBe("ok");
      expect(row.syncError).toBeNull();
    }
    expect(await documentCount()).toBe(docsBefore);
    const lastRun = (await h.db.select().from(syncRuns).orderBy(asc(syncRuns.id))).at(-1);
    expect(lastRun).toMatchObject({ trigger: "webhook", scope: null });
  });

  // Task 6.4: repeated and concurrent deliveries.

  /** Stored rows that a sync writes, without ids and timestamps. */
  async function stored() {
    const repoRows = await h.db
      .select({
        githubId: repos.githubId,
        visibility: repos.visibility,
        treeSha: repos.treeSha,
        headEtag: repos.headEtag,
        readmeSha: repos.readmeSha,
        syncStatus: repos.syncStatus,
        syncError: repos.syncError,
        syncRequestedAt: repos.syncRequestedAt,
      })
      .from(repos)
      .orderBy(asc(repos.githubId));
    const docRows = await h.db
      .select({
        githubId: repos.githubId,
        path: documents.path,
        blobSha: documents.blobSha,
        title: documents.title,
        body: documents.body,
        frontmatter: documents.frontmatter,
      })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .orderBy(asc(repos.githubId), asc(documents.path));
    return { repoRows, docRows };
  }

  const BLOBS = /^\/repos\/acme\/handbook\/git\/blobs\//;
  const TREES = /^\/repos\/acme\/handbook\/git\/trees\//;

  it("a duplicate push delivery stores the same result as one delivery and refetches nothing", async () => {
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nPushed once.\n");
    const push = pushPayload(HANDBOOK_ID, "handbook");
    fake.clearRequests();
    await send("push", push);
    const once = await stored();
    expect(fake.requestsTo(BLOBS)).toHaveLength(1);

    await send("push", push); // the same delivery again
    expect(await stored()).toEqual(once);
    expect(fake.requestsTo(BLOBS)).toHaveLength(1);
    expect(fake.requestsTo(TREES)).toHaveLength(1);
  });

  it("the same delivery twice at once runs no overlapping syncs and stores the same result", async () => {
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nPushed once.\n");
    const push = pushPayload(HANDBOOK_ID, "handbook");
    await send("push", push);
    const once = await stored();

    // Same starting point, then two deliveries dispatched before either finishes.
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nHello.\n");
    await send("push", push);
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nPushed once.\n");
    fake.clearRequests();
    await Promise.all([
      dispatch("push", push, "delivery-dup"),
      dispatch("push", push, "delivery-dup"),
    ]);
    await tasks.idle();
    expect(await stored()).toEqual(once);
    expect(fake.requestsTo(BLOBS)).toHaveLength(1);
    expect(fake.requestsTo(TREES)).toHaveLength(1);
    // Each run of the repo held its lock alone: no two single-repo runs overlapped in time.
    const runs = (await h.db.select().from(syncRuns).orderBy(asc(syncRuns.id))).filter(
      (r) => r.scope === "acme/handbook",
    );
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.startedAt.getTime()).toBeGreaterThanOrEqual(
        runs[i - 1]!.finishedAt!.getTime(),
      );
    }
  });

  it("a push that arrives while its repository is syncing is coalesced and synced right after", async () => {
    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nFirst push.\n");
    let reached!: () => void;
    const atBlob = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    fake.onRequest = async (request) => {
      if (paused || !BLOBS.test(request.path)) return;
      paused = true;
      reached();
      await gate;
    };
    await dispatch("push", pushPayload(HANDBOOK_ID, "handbook"), "delivery-a");
    await atBlob; // the first sync already has the first push's tree

    fake.setFile(HANDBOOK_ID, "docs/start.md", "# Start\n\nSecond push.\n");
    await dispatch("push", pushPayload(HANDBOOK_ID, "handbook"), "delivery-b");
    // Let the second delivery's background task run to its answer while the first is paused.
    for (
      let i = 0;
      i < 50 && !logged.some((l) => l.includes("deliveryId=delivery-b task=sync"));
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
      await h.db.execute(sql`select 1`);
    }
    expect(logged).toContain(
      `webhook.task.finished githubEvent=push action=- deliveryId=delivery-b task=sync githubId=${HANDBOOK_ID} status=coalesced`,
    );
    release();
    await tasks.idle();

    expect((await docsOf(HANDBOOK_ID)).find((d) => d.path === "docs/start.md")?.body).toContain(
      "Second push.",
    );
    expect((await repoRow(HANDBOOK_ID))?.syncRequestedAt).toBeNull();
  });

  it("ignores an installation event for another installation", async () => {
    await send("installation", { action: "deleted", installation: { id: INSTALLATION + 1 } });
    for (const row of await h.db.select().from(repos)) expect(row.syncStatus).toBe("ok");
  });
});
