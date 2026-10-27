import { generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";

import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DomainEventInput } from "@docmyrepos/core";

import { configSchema, type AppConfigInput } from "@docmyrepos/core/internal/config/schema";
import { Secret } from "../config/secret";
import { withRepoSyncLock } from "../db/advisory-lock";
import { createDb, type DbHandle } from "../db/client";
import { codeOwners, documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createInstallationTokenProvider } from "../github/app-auth";
import { createGitHubClient } from "../github/client";
import { getDocsTree, searchDocuments } from "../queries";
import { recordingLogger } from "../test-logger";
import {
  createSyncContext,
  effectiveRepoConcurrency,
  poolMax,
  repoConcurrencyFor,
  syncAll,
  syncOne,
  syncRepo,
  syncRepoLocked,
  type SyncContext,
  type SyncTuning,
} from "./engine";
import { FakeGitHub, gitBlobSha, type FakeRepoInit } from "../../../../tests/support/fake-github";
import { REPO_BUSY_MESSAGE } from "./runs";

// ---------------------------------------------------------------------------------------------
// Fixture

const OWNER = "acme";
const HANDBOOK_ID = 101;
const METRICS_ID = 202;
const SANDBOX_ID = 303;
const ARCHIVED_ID = 404;

/** A plain Markdown repo: no `type` anywhere. Private. Both CODEOWNERS locations. */
function handbook(): FakeRepoInit {
  return {
    id: HANDBOOK_ID,
    name: "handbook",
    visibility: "private",
    description: "Company handbook",
    files: {
      "README.md": "# Handbook\n\nThe company handbook.\n",
      ".github/CODEOWNERS": "* @acme/docs-team\n/docs/ @alice\n",
      CODEOWNERS: "* @ignored-root-file\n",
      "docs/getting-started.md": "# Getting Started\n\nWelcome.\n\n## Install\n\nRun it.\n",
      "docs/guides/deploy.md":
        "---\ntitle: Deploying\ndescription: How to deploy\n---\n\n# Deploy\n\n## Steps\n",
      "docs/node_modules/pkg/readme.md": "# vendored\n",
      "src/index.ts": "export {};\n",
    },
  };
}

/** An OKF bundle: `type` frontmatter and a root index.md declaring okf_version. */
function metrics(): FakeRepoInit {
  return {
    id: METRICS_ID,
    name: "metrics",
    visibility: "public",
    files: {
      "README.md": "# Metrics\n",
      CODEOWNERS: "*.md @acme/analysts\n",
      "docs/index.md": '---\nokf_version: "0.2"\ntitle: Metrics bundle\n---\n\n# Metrics\n',
      "docs/revenue.md":
        "---\ntype: Metric\ntags: [finance, kpi]\nstatus: draft\nowner_team: growth\n---\n\n# Revenue\n\n## Definition\n",
      "docs/log.md": "# Log\n\n- created\n",
      "docs/notes/churn.md": "---\ntype: Note\n---\n\nChurn notes.\n",
    },
  };
}

function sandbox(): FakeRepoInit {
  return { id: SANDBOX_ID, name: "sandbox", files: { "docs/a.md": "# A\n" } };
}

function archived(): FakeRepoInit {
  return { id: ARCHIVED_ID, name: "old", archived: true, files: { "docs/a.md": "# A\n" } };
}

function fixture(extra: FakeRepoInit[] = [], token?: string): FakeGitHub {
  return new FakeGitHub({
    owner: OWNER,
    token,
    repos: [handbook(), metrics(), sandbox(), archived(), ...extra],
  });
}

// Throwaway App key, generated per run.
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_SENTINEL = PEM.split("\n")[3] as string;

const BLOBS = /\/git\/blobs\//;
const TREES = /\/git\/trees\//;
const BRANCHES = /\/branches\//;

// ---------------------------------------------------------------------------------------------
// Unit: context

describe("createSyncContext", () => {
  const base = () => ({
    db: {} as never,
    pool: {} as never,
    github: {} as never,
    config: configSchema.parse({}),
  });

  it("applies tuning defaults and freezes", () => {
    const ctx = createSyncContext(base());
    expect(ctx.tuning).toEqual({ repoConcurrency: 1, blobConcurrency: 8, lockWaitMs: 0 });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(inspect(ctx)).toBe("[redacted]");
    expect(JSON.stringify({ ctx })).toBe('{"ctx":"[redacted]"}');
  });

  it("rejects bad tuning numbers", () => {
    for (const tuning of [
      { repoConcurrency: 0 },
      { repoConcurrency: 1.5 },
      { blobConcurrency: -1 },
      { lockWaitMs: Number.NaN },
      { lockWaitMs: -1 },
    ] as SyncTuning[]) {
      expect(() => createSyncContext({ ...base(), tuning })).toThrow(TypeError);
    }
  });

  it("clamps repoConcurrency to what the pool can serve, logging once per context", () => {
    expect(poolMax({} as never)).toBe(10);
    expect(poolMax({ options: { max: 25 } } as never)).toBe(25);
    expect(poolMax({ options: { max: 0 } } as never)).toBe(10);
    // floor((max - 2) / 3), at least 1, never above the request.
    expect(effectiveRepoConcurrency(8, 10)).toBe(2);
    expect(effectiveRepoConcurrency(1, 10)).toBe(1);
    expect(effectiveRepoConcurrency(4, 1)).toBe(1);
    expect(effectiveRepoConcurrency(4, 5)).toBe(1);
    expect(effectiveRepoConcurrency(4, 14)).toBe(4);
    expect(effectiveRepoConcurrency(10, 32)).toBe(10);

    const rec = recordingLogger();
    const ctx = createSyncContext({
      ...base(),
      pool: { options: { max: 8 } } as never,
      tuning: { repoConcurrency: 4 },
      log: rec.log,
    });
    expect(repoConcurrencyFor(ctx)).toBe(2);
    expect(repoConcurrencyFor(ctx)).toBe(2);
    expect(rec.find("sync.concurrency.clamped")).toEqual([
      expect.objectContaining({ requested: 4, effective: 2, poolMax: 8, level: "warn" }),
    ]);

    const fits = createSyncContext({
      ...base(),
      pool: { options: { max: 20 } } as never,
      tuning: { repoConcurrency: 4 },
      log: rec.log,
    });
    expect(repoConcurrencyFor(fits)).toBe(4);
    expect(rec.find("sync.concurrency.clamped")).toHaveLength(1);
  });

  it("accepts the frozen config shape loadConfig returns", () => {
    const frozen = Object.freeze(configSchema.parse({ repos: [{ name: "a", docsPath: "x" }] }));
    expect(createSyncContext({ ...base(), config: frozen }).config).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------------------------
// Integration: real client over the fake GitHub, real test database

describeDb("sync engine against a fixture-backed fake GitHub", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // A larger pool than the test default: a run holds the run lock, a repo lock, a transaction,
    // and a test may hold a repo lock of its own.
    h = createDb(testDb.url.reveal(), { max: 10 });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await h.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
  });

  function ctxFor(
    fake: FakeGitHub,
    options: { config?: AppConfigInput; auth?: "stub" | "real"; tuning?: SyncTuning } = {},
  ): SyncContext {
    const getToken =
      options.auth === "real"
        ? createInstallationTokenProvider({
            appId: 12345,
            installationId: fake.installationId,
            privateKey: new Secret(PEM),
            fetch: fake.fetch,
            sleep: async () => undefined,
          }).getToken
        : fake.getToken;
    const github = createGitHubClient({
      getToken,
      fetch: fake.fetch,
      sleep: async () => undefined,
      maxWaitMs: 1_000,
    });
    return createSyncContext({
      db: h.db,
      pool: h.pool,
      github,
      config: configSchema.parse(options.config ?? { exclude: ["sandbox"] }),
      tuning: options.tuning,
    });
  }

  // Every documents column but the (large) search vector.
  const docColumns = Object.fromEntries(
    Object.entries(getTableColumns(documents)).filter(([key]) => key !== "searchVector"),
  ) as Omit<ReturnType<typeof getTableColumns<typeof documents>>, "searchVector">;

  async function repoRow(githubId: number) {
    const [row] = await h.db.select().from(repos).where(eq(repos.githubId, githubId));
    return row;
  }

  async function docs(githubId: number) {
    return h.db
      .select(docColumns)
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(eq(repos.githubId, githubId))
      .orderBy(asc(documents.path));
  }

  async function owners(githubId: number) {
    return h.db
      .select({
        position: codeOwners.position,
        pattern: codeOwners.pattern,
        owners: codeOwners.owners,
        sourcePath: codeOwners.sourcePath,
      })
      .from(codeOwners)
      .innerJoin(repos, eq(repos.id, codeOwners.repoId))
      .where(eq(repos.githubId, githubId))
      .orderBy(asc(codeOwners.position));
  }

  async function runs() {
    return h.db.select().from(syncRuns).orderBy(asc(syncRuns.id));
  }

  async function repoCount() {
    return (await h.db.select({ id: repos.id }).from(repos)).length;
  }

  it("emits one sync.completed event per repository, with counts only", async () => {
    const fake = fixture();
    const events: DomainEventInput[] = [];
    const ctx = { ...ctxFor(fake), emit: (event: DomainEventInput) => events.push(event) };
    await syncAll(ctx, { trigger: "manual" });
    expect(events.map((e) => e.name)).toEqual(["sync.completed", "sync.completed"]);
    expect(events.map((e) => (e.payload as { githubRepoId: number }).githubRepoId).sort()).toEqual(
      [HANDBOOK_ID, METRICS_ID].sort(),
    );
    for (const event of events) {
      expect(Object.keys(event.payload).sort()).toEqual(
        ["added", "changed", "githubRepoId", "removed", "trigger"].sort(),
      );
      expect(event.payload).toMatchObject({ trigger: "manual", changed: 0, removed: 0 });
      expect((event.payload as { added: number }).added).toBeGreaterThan(0);
    }
    // A second sync that finds nothing new still reports each repository, with nothing added.
    events.length = 0;
    await syncAll(ctx, { trigger: "schedule" });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.name === "sync.completed")).toBe(true);
    expect(events.every((e) => (e.payload as { added: number }).added === 0)).toBe(true);
  });

  // (1)
  it("first full sync stores a plain repo and an OKF repo with README, owners and run stats", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    const result = await syncAll(ctx, { trigger: "manual" });

    expect(result.run.ran).toBe(true);
    if (!result.run.ran) return;
    expect(result.run.status).toBe("success");
    expect(result.discovery?.complete).toBe(true);
    expect(result.discoveredGithubIds).toEqual([HANDBOOK_ID, METRICS_ID]);
    if (result.discovery?.complete) {
      expect(result.discovery.skipped.map((s) => [s.name, s.reason])).toEqual([
        ["sandbox", "excluded"],
        ["old", "archived"],
      ]);
    }

    // Plain Markdown repo.
    const hb = await repoRow(HANDBOOK_ID);
    expect(hb).toMatchObject({
      owner: OWNER,
      name: "handbook",
      description: "Company handbook",
      defaultBranch: "main",
      visibility: "private",
      docsPath: "docs",
      isOkf: false,
      okfVersion: null,
      syncStatus: "ok",
      syncError: null,
      readmePath: "README.md",
      readmeMarkdown: "# Handbook\n\nThe company handbook.\n",
      codeownersPath: ".github/CODEOWNERS",
      treeSha: fake.treeSha(HANDBOOK_ID),
    });
    expect(hb?.lastSyncedAt).toBeInstanceOf(Date);
    const hbDocs = await docs(HANDBOOK_ID);
    expect(hbDocs.map((d) => [d.path, d.title, d.type])).toEqual([
      ["docs/getting-started.md", "Getting Started", null],
      ["docs/guides/deploy.md", "Deploying", null],
    ]);
    expect(hbDocs[0]?.headings.map((x) => x.text)).toEqual(["Getting Started", "Install"]);
    expect(hbDocs[1]?.description).toBe("How to deploy");
    expect(hbDocs[0]?.blobSha).toBe(
      gitBlobSha("# Getting Started\n\nWelcome.\n\n## Install\n\nRun it.\n"),
    );
    expect(await owners(HANDBOOK_ID)).toEqual([
      {
        position: 0,
        pattern: "*",
        owners: [{ handle: "@acme/docs-team", kind: "team" }],
        sourcePath: ".github/CODEOWNERS",
      },
      {
        position: 1,
        pattern: "/docs/",
        owners: [{ handle: "@alice", kind: "user" }],
        sourcePath: ".github/CODEOWNERS",
      },
    ]);

    // OKF repo.
    const mt = await repoRow(METRICS_ID);
    expect(mt).toMatchObject({
      visibility: "public",
      isOkf: true,
      okfVersion: "0.2",
      syncStatus: "ok",
      codeownersPath: "CODEOWNERS",
    });
    const mtDocs = await docs(METRICS_ID);
    expect(mtDocs.map((d) => [d.path, d.type, d.reserved])).toEqual([
      ["docs/index.md", null, "index"],
      ["docs/log.md", null, "log"],
      ["docs/notes/churn.md", "Note", null],
      ["docs/revenue.md", "Metric", null],
    ]);
    const revenue = mtDocs.find((d) => d.path === "docs/revenue.md");
    expect(revenue).toMatchObject({ title: "Revenue", tags: ["finance", "kpi"], status: "draft" });
    expect(revenue?.frontmatter).toMatchObject({ owner_team: "growth", type: "Metric" });
    expect((await owners(METRICS_ID)).map((o) => o.pattern)).toEqual(["*.md"]);

    // Excluded and archived repos are not stored.
    expect(await repoRow(SANDBOX_ID)).toBeUndefined();
    expect(await repoRow(ARCHIVED_ID)).toBeUndefined();

    // Run row.
    const [run] = await runs();
    expect(run).toMatchObject({
      trigger: "manual",
      scope: null,
      status: "success",
      reposTotal: 2,
      reposSynced: 2,
      reposUnchanged: 0,
      reposFailed: 0,
      docsAdded: 6,
      docsUpdated: 0,
      docsRemoved: 0,
      error: null,
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.docsSkipped).toBe(1);
    const hbEntry = run?.results.find((r) => r.githubId === HANDBOOK_ID);
    expect(hbEntry).toMatchObject({ status: "ok", added: 2 });
    expect(hbEntry?.skippedFiles).toEqual([
      { path: "docs/node_modules/pkg/readme.md", reason: "ignored_folder" },
    ]);

    // Requests: one listing, one head and one tree per repo, blobs for docs + README + CODEOWNERS.
    expect(fake.requestsTo(/^\/installation\/repositories$/)).toHaveLength(1);
    expect(fake.requestsTo(BRANCHES)).toHaveLength(2);
    expect(fake.requestsTo(TREES)).toHaveLength(2);
    expect(fake.requestsTo(BLOBS)).toHaveLength(4 + 6);
    expect(fake.requestsTo(/\/repos\/acme\/(sandbox|old)/)).toHaveLength(0);
  });

  // (2)
  it("a repoConcurrency larger than the pool allows is clamped and the run still succeeds", async () => {
    const fake = fixture();
    // Pool max 10 -> at most 2 repos at once; 16 would exhaust the pool and fail lock takes.
    const ctx = ctxFor(fake, { tuning: { repoConcurrency: 16 }, config: {} });
    expect(repoConcurrencyFor(ctx)).toBe(2);
    const result = await syncAll(ctx, { trigger: "manual" });
    expect(result.fatal).toBeNull();
    expect(result.run.ran && result.run.status).toBe("success");
    expect(result.run.ran && result.run.value.map((e) => e.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("a second sync with no changes fetches no trees or blobs and leaves rows identical", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const before = {
      hb: await repoRow(HANDBOOK_ID),
      mt: await repoRow(METRICS_ID),
      hbDocs: await docs(HANDBOOK_ID),
      mtDocs: await docs(METRICS_ID),
      hbOwners: await owners(HANDBOOK_ID),
    };
    fake.clearRequests();

    const result = await syncAll(ctx, { trigger: "schedule" });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(fake.requestsTo(BLOBS)).toHaveLength(0);
    expect(fake.requestsTo(TREES)).toHaveLength(0);
    expect(fake.requestsTo(BRANCHES)).toHaveLength(2);
    // The heads were conditional requests that came back 304.
    expect(fake.requests.length).toBe(3);

    const strip = <T extends { updatedAt: Date; lastSyncedAt: Date | null }>(
      row: T | undefined,
    ) => {
      const rest: Partial<T> = { ...(row as T) };
      delete rest.updatedAt;
      delete rest.lastSyncedAt;
      return rest;
    };
    expect(strip(await repoRow(HANDBOOK_ID))).toEqual(strip(before.hb));
    expect(strip(await repoRow(METRICS_ID))).toEqual(strip(before.mt));
    expect(await docs(HANDBOOK_ID)).toEqual(before.hbDocs);
    expect(await docs(METRICS_ID)).toEqual(before.mtDocs);
    expect(await owners(HANDBOOK_ID)).toEqual(before.hbOwners);

    const [, second] = await runs();
    expect(second).toMatchObject({
      trigger: "schedule",
      status: "success",
      reposUnchanged: 2,
      reposSynced: 0,
      docsAdded: 0,
      docsUpdated: 0,
      docsRemoved: 0,
    });
    expect(second?.results.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
  });

  // (3)
  it("one changed file is one blob fetch and one updated row; a deleted file removes its row", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const before = await docs(HANDBOOK_ID);
    fake.clearRequests();

    const changed = "# Getting Started Again\n\nUpdated.\n";
    fake.setFile(HANDBOOK_ID, "docs/getting-started.md", changed);
    await syncAll(ctx, { trigger: "webhook" });

    const blobs = fake.requestsTo(BLOBS);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.path).toBe(`/repos/acme/handbook/git/blobs/${gitBlobSha(changed)}`);
    const after = await docs(HANDBOOK_ID);
    expect(after[0]).toMatchObject({
      title: "Getting Started Again",
      blobSha: gitBlobSha(changed),
    });
    expect(after[0]?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before[0]?.updatedAt.getTime() ?? 0,
    );
    expect(after[1]).toEqual(before[1]);
    const [, second] = await runs();
    expect(second).toMatchObject({
      docsUpdated: 1,
      docsAdded: 0,
      reposSynced: 1,
      reposUnchanged: 1,
    });

    fake.clearRequests();
    fake.deleteFile(HANDBOOK_ID, "docs/guides/deploy.md");
    await syncAll(ctx, { trigger: "webhook" });
    expect(fake.requestsTo(BLOBS)).toHaveLength(0);
    expect((await docs(HANDBOOK_ID)).map((d) => d.path)).toEqual(["docs/getting-started.md"]);
    const [, , third] = await runs();
    expect(third).toMatchObject({ docsRemoved: 1, status: "success" });
  });

  // (4)
  it("a repo whose tree fetch fails keeps its content, is marked error, and the others sync", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const hbBefore = await docs(HANDBOOK_ID);
    const treeBefore = (await repoRow(HANDBOOK_ID))?.treeSha;

    fake.setFile(HANDBOOK_ID, "docs/getting-started.md", "# Changed\n");
    fake.setFile(METRICS_ID, "docs/new.md", "---\ntype: Metric\n---\n# New\n");
    fake.fail({ path: /^\/repos\/acme\/handbook\/git\/trees\//, status: 500 });
    const result = await syncAll(ctx, { trigger: "manual" });

    expect(result.run.ran && result.run.status).toBe("partial");
    const hb = await repoRow(HANDBOOK_ID);
    expect(hb).toMatchObject({
      syncStatus: "error",
      syncError: "GitHub server error; retried on the next sync",
      treeSha: treeBefore,
    });
    expect(await docs(HANDBOOK_ID)).toEqual(hbBefore);
    expect((await docs(METRICS_ID)).map((d) => d.path)).toContain("docs/new.md");
    expect((await repoRow(METRICS_ID))?.syncStatus).toBe("ok");
    const [, run] = await runs();
    expect(run).toMatchObject({ status: "partial", reposFailed: 1, reposSynced: 1 });
    expect(run?.results.find((r) => r.githubId === HANDBOOK_ID)).toMatchObject({
      status: "error",
      errorKind: "server",
      retryable: true,
    });

    // Recovers on the next sync once GitHub answers again.
    fake.clearFailures();
    await syncAll(ctx, { trigger: "manual" });
    expect(await repoRow(HANDBOOK_ID)).toMatchObject({ syncStatus: "ok", syncError: null });
    expect((await docs(HANDBOOK_ID))[0]?.title).toBe("Changed");
  });

  // (5)
  it("a rate limit stops the run: later repos are skipped and their rows untouched", async () => {
    const fake = fixture([{ id: 505, name: "zeta", files: { "docs/z.md": "# Z\n" } }]);
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const zetaBefore = await repoRow(505);
    const mtDocsBefore = await docs(METRICS_ID);

    const reset = Math.floor(Date.now() / 1000) + 3600;
    fake.fail({
      path: /^\/repos\/acme\/metrics\/branches\//,
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    fake.clearRequests();
    const result = await syncAll(ctx, { trigger: "manual" });

    expect(result.run.ran && result.run.status).toBe("failed");
    const [, run] = await runs();
    expect(run?.error).toMatch(/^GitHub rate limit exhausted; retry after \d{4}-/);
    expect(run?.results.map((r) => [r.githubId, r.status])).toEqual([
      [HANDBOOK_ID, "unchanged"],
      [METRICS_ID, "error"],
      [505, "skipped"],
    ]);
    expect(run?.results[2]?.errorKind).toBe("rate_limited");
    expect(fake.requestsTo(/\/repos\/acme\/zeta\//)).toHaveLength(0);
    expect(await repoRow(505)).toEqual(zetaBefore);
    expect(await docs(METRICS_ID)).toEqual(mtDocsBefore);
    expect((await repoRow(METRICS_ID))?.syncError).toMatch(/^GitHub rate limit exhausted/);
  });

  // (6)
  it("an installation 404 on the listing marks stored repos error, keeps content, deletes nothing", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const docsBefore = [await docs(HANDBOOK_ID), await docs(METRICS_ID)];

    fake.fail({ path: "/installation/repositories", status: 404 });
    const result = await syncAll(ctx, { trigger: "manual" });

    expect(result.discovery?.complete).toBe(false);
    expect(result.discoveredGithubIds).toEqual([]);
    expect(result.run.ran && result.run.status).toBe("failed");
    expect(await repoCount()).toBe(2);
    expect([await docs(HANDBOOK_ID), await docs(METRICS_ID)]).toEqual(docsBefore);
    for (const id of [HANDBOOK_ID, METRICS_ID]) {
      expect(await repoRow(id)).toMatchObject({
        syncStatus: "error",
        syncError: "GitHub App installation unavailable",
      });
    }
    const [, run] = await runs();
    expect(run).toMatchObject({ status: "failed", error: "GitHub App installation unavailable" });
    expect(run?.results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
  });

  it("an uninstalled App (token mint 404, real token provider) is handled the same way", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake, { auth: "real" }), { trigger: "manual" });
    expect(await repoCount()).toBe(2);

    fake.installationGone = true;
    const result = await syncAll(ctxFor(fake, { auth: "real" }), { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("failed");
    expect(await repoCount()).toBe(2);
    expect((await docs(METRICS_ID)).length).toBe(4);
    expect((await repoRow(HANDBOOK_ID))?.syncError).toBe("GitHub App installation unavailable");
  });

  it("a listing failure that is not installation-wide fails the run and leaves rows untouched", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const before = await repoRow(HANDBOOK_ID);
    fake.fail({ path: "/installation/repositories", status: 502 });
    const result = await syncAll(ctx, { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("failed");
    expect(await repoRow(HANDBOOK_ID)).toEqual(before);
    const [, run] = await runs();
    expect(run?.error).toBe("GitHub server error; retried on the next sync");
  });

  // (7)
  it("a private-to-public flip is recorded without refetching content", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("private");

    fake.updateRepo(HANDBOOK_ID, { visibility: "public" });
    fake.clearRequests();
    await syncAll(ctx, { trigger: "manual" });
    expect((await repoRow(HANDBOOK_ID))?.visibility).toBe("public");
    expect(fake.requestsTo(BLOBS)).toHaveLength(0);
    expect(fake.requestsTo(TREES)).toHaveLength(0);

    // A failed sync still records GitHub's visibility (content kept).
    fake.updateRepo(HANDBOOK_ID, { visibility: "internal" });
    fake.setFile(HANDBOOK_ID, "docs/x.md", "# X\n");
    fake.fail({ path: /^\/repos\/acme\/handbook\/git\/trees\//, status: 500 });
    await syncAll(ctx, { trigger: "manual" });
    expect(await repoRow(HANDBOOK_ID)).toMatchObject({
      visibility: "private",
      syncStatus: "error",
    });
  });

  // (8)
  it("a repo without a docs folder, and an empty repo, sync with zero docs", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [
        {
          id: 601,
          name: "infra",
          files: { "README.md": "# Infra\n", "src/main.tf": "x\n", "notes/a.md": "# A\n" },
        },
        { id: 602, name: "blank", defaultBranch: null },
      ],
    });
    const result = await syncAll(ctxFor(fake, { config: {} }), { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(await repoRow(601)).toMatchObject({
      docsPath: null,
      syncStatus: "ok",
      readmeMarkdown: "# Infra\n",
      isOkf: false,
    });
    expect(await docs(601)).toEqual([]);
    expect(await repoRow(602)).toMatchObject({
      syncStatus: "ok",
      defaultBranch: "",
      treeSha: null,
    });
    expect(await docs(602)).toEqual([]);
    const [run] = await runs();
    expect(run?.results.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  // (9)
  it("a repo whose lock is held elsewhere is skipped as busy and the rest sync", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    const held = await withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, () =>
      syncAll(ctx, { trigger: "manual" }),
    );
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    expect(held.value.run.ran && held.value.run.status).toBe("success");
    const [run] = await runs();
    expect(run?.results.map((r) => [r.githubId, r.status, r.error])).toEqual([
      [HANDBOOK_ID, "skipped", REPO_BUSY_MESSAGE],
      [METRICS_ID, "ok", null],
    ]);
    expect(await repoRow(HANDBOOK_ID)).toBeUndefined();
    expect((await repoRow(METRICS_ID))?.syncStatus).toBe("ok");
  });

  // (10)
  it("syncOne syncs a configured repo by name or id in a scoped run", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    const byName = await syncOne(ctx, { owner: "ACME", name: "Metrics" }, { trigger: "manual" });
    expect(byName.status).toBe("synced");
    if (byName.status !== "synced") return;
    expect(byName.repo.githubId).toBe(METRICS_ID);
    expect(byName.result).toMatchObject({ status: "ok", added: 4 });
    expect(fake.requestsTo(/\/repos\/acme\/handbook\//)).toHaveLength(0);

    const byId = await syncOne(ctx, { githubId: HANDBOOK_ID }, { trigger: "webhook" });
    expect(byId.status === "synced" && byId.result?.status).toBe("ok");

    expect((await runs()).map((r) => [r.scope, r.status, r.reposTotal])).toEqual([
      ["acme/metrics", "success", 1],
      ["acme/handbook", "success", 1],
    ]);
    expect(await repoCount()).toBe(2);
  });

  it("syncOne accepts a bare repository name (the installation has one owner)", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    const result = await syncOne(ctx, { name: "Metrics" }, { trigger: "manual" });
    expect(result.status === "synced" && result.repo.githubId).toBe(METRICS_ID);
    expect((await syncOne(ctx, { name: "nope" }, { trigger: "manual" })).status).toBe("not_found");
    expect(await syncOne(ctx, { name: "sandbox" }, { trigger: "manual" })).toMatchObject({
      status: "not_configured",
      reason: "excluded",
    });
    await expect(syncOne(ctx, { name: "" }, { trigger: "manual" })).rejects.toThrow(TypeError);
    await expect(syncOne(ctx, { owner: "", name: "x" }, { trigger: "manual" })).rejects.toThrow(
      TypeError,
    );

    fake.fail({ path: "/installation/repositories", status: 404 });
    const failed = await syncOne(ctx, { name: "metrics" }, { trigger: "manual" });
    expect(failed.status).toBe("discovery_failed");
    expect((await runs()).map((r) => r.scope)).toEqual(["acme/metrics", "acme/metrics"]);
    const never = await syncOne(ctx, { name: "ghost" }, { trigger: "manual" });
    expect(never.status).toBe("discovery_failed");
    expect((await runs()).at(-1)?.scope).toBe("ghost");
  });

  it("syncAll reports the error that stopped the run as fatal", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    expect((await syncAll(ctx, { trigger: "manual" })).fatal).toBeNull();
    fake.fail({ path: "/installation/repositories", status: 404 });
    const failed = await syncAll(ctx, { trigger: "manual" });
    expect(failed.fatal).toMatchObject({ kind: "installation_unavailable", retryable: true });
  });

  it("syncOne reports unknown and unconfigured repos without starting a run", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    expect(
      (await syncOne(ctx, { owner: OWNER, name: "nope" }, { trigger: "webhook" })).status,
    ).toBe("not_found");
    expect((await syncOne(ctx, { githubId: 999 }, { trigger: "webhook" })).status).toBe(
      "not_found",
    );
    expect(
      await syncOne(ctx, { owner: OWNER, name: "sandbox" }, { trigger: "webhook" }),
    ).toMatchObject({ status: "not_configured", reason: "excluded" });
    expect(await syncOne(ctx, { githubId: ARCHIVED_ID }, { trigger: "webhook" })).toMatchObject({
      status: "not_configured",
      reason: "archived",
    });
    const explicit = ctxFor(fake, { config: { repos: ["handbook"] } });
    expect(
      await syncOne(explicit, { owner: OWNER, name: "metrics" }, { trigger: "manual" }),
    ).toMatchObject({
      status: "not_configured",
      reason: "not_listed",
    });
    expect(await runs()).toEqual([]);
    expect(await repoCount()).toBe(0);
    await expect(syncOne(ctx, { githubId: 0 }, { trigger: "manual" })).rejects.toThrow(TypeError);
  });

  it("syncOne with a failed listing records a failed run and marks only its repo", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    fake.fail({ path: "/installation/repositories", status: 404 });
    const result = await syncOne(ctx, { githubId: HANDBOOK_ID }, { trigger: "webhook" });
    expect(result).toMatchObject({
      status: "discovery_failed",
      error: { kind: "installation_unavailable" },
    });
    expect((await repoRow(HANDBOOK_ID))?.syncStatus).toBe("error");
    expect((await repoRow(METRICS_ID))?.syncStatus).toBe("ok");
    const [, run] = await runs();
    expect(run).toMatchObject({ scope: "acme/handbook", status: "failed" });
  });

  it("a config-listed repo the installation cannot access is reported and removed (task 5.9)", async () => {
    const fake = fixture([{ id: 707, name: "ghost", files: { "docs/g.md": "# G\n" } }]);
    await syncAll(ctxFor(fake, { config: {} }), { trigger: "manual" });
    expect((await docs(707)).length).toBe(1);

    fake.removeRepo(707);
    const ctx = ctxFor(fake, { config: { repos: ["handbook", "ghost", "never-existed"] } });
    const result = await syncAll(ctx, { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("partial");
    if (result.discovery?.complete) {
      expect(result.discovery.inaccessible.map((i) => i.name)).toEqual(["ghost", "never-existed"]);
    }
    // Absent from a complete listing: removed, and the run says why.
    expect(await repoRow(707)).toBeUndefined();
    expect(await docs(707)).toEqual([]);
    const [, run] = await runs();
    expect(
      run?.results.map((r) => [r.repo, r.githubId, r.status, r.errorKind, r.removalReason]),
    ).toEqual([
      ["acme/handbook", HANDBOOK_ID, "unchanged", null, undefined],
      ["acme/metrics", METRICS_ID, "removed", null, "dropped_from_config"],
      ["acme/sandbox", SANDBOX_ID, "removed", null, "dropped_from_config"],
      ["acme/ghost", 707, "removed", "not_accessible", "not_in_installation"],
      ["never-existed", 0, "error", "not_accessible", undefined],
    ]);
    expect(await repoRow(METRICS_ID)).toBeUndefined();
  });

  // Spec scenarios "One file changed" (search data updated) and "File deleted upstream" (gone from
  // the table of contents and from search).
  it("a changed file is searchable by its new text at once; a deleted file leaves search and the tree", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    const searchPaths = async (q: string) =>
      (await searchDocuments(h.db, { q })).hits.map((hit) => hit.doc.path);
    const treePaths = async () =>
      (await getDocsTree(h.db, { id: (await repoRow(HANDBOOK_ID))?.id as number })).map(
        (row) => row.path,
      );

    await syncAll(ctx, { trigger: "manual" });
    expect(await searchPaths("Welcome")).toEqual(["docs/getting-started.md"]);
    expect(await searchPaths("zebrafish")).toEqual([]);
    expect(await searchPaths("Deploying")).toEqual(["docs/guides/deploy.md"]);
    expect(await treePaths()).toEqual(["docs/getting-started.md", "docs/guides/deploy.md"]);

    fake.setFile(HANDBOOK_ID, "docs/getting-started.md", "# Getting Started\n\nZebrafish only.\n");
    await syncAll(ctx, { trigger: "webhook" });
    expect(await searchPaths("zebrafish")).toEqual(["docs/getting-started.md"]);
    expect(await searchPaths("Welcome")).toEqual([]);

    fake.deleteFile(HANDBOOK_ID, "docs/guides/deploy.md");
    await syncAll(ctx, { trigger: "webhook" });
    expect(await searchPaths("Deploying")).toEqual([]);
    expect(await searchPaths("Steps")).toEqual([]);
    expect(await treePaths()).toEqual(["docs/getting-started.md"]);
  });

  // Spec scenarios "Malformed frontmatter" (synced, no metadata, warning recorded) and, for OKF,
  // "Only the required key" (title from the file name, no error).
  it("a document with malformed frontmatter is synced without metadata and the run records a warning", async () => {
    const fake = fixture([
      {
        id: 707,
        name: "notes",
        files: {
          "docs/broken.md":
            "---\ntitle: [unclosed\nfoo: : bar\n---\n# Broken Heading\n\nBody text here.\n",
          "docs/type-only.md": "---\ntype: Note\n---\n\nJust a body, no heading.\n",
        },
      },
    ]);
    const result = await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(await repoRow(707)).toMatchObject({ syncStatus: "ok", syncError: null, isOkf: true });

    const stored = await docs(707);
    const broken = stored.find((d) => d.path === "docs/broken.md");
    expect(broken).toBeDefined();
    expect(broken).toMatchObject({ frontmatter: {}, type: null, title: "Broken Heading" });
    expect(broken?.body).toContain("title: [unclosed");
    expect(broken?.body).toContain("Body text here.");

    // `type` alone: the file name is the title, and nothing is reported.
    const typeOnly = stored.find((d) => d.path === "docs/type-only.md");
    expect(typeOnly).toMatchObject({
      type: "Note",
      title: "Type only",
      frontmatter: { type: "Note" },
      description: null,
    });

    const [run] = await runs();
    const entry = run?.results.find((r) => r.githubId === 707);
    expect(entry).toMatchObject({ status: "ok", added: 2 });
    expect(entry?.warnings).toEqual([
      { path: "docs/broken.md", message: expect.stringMatching(/not valid YAML/) },
    ]);
  });

  it("a truncated tree is a repo error that keeps stored content", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    const before = await docs(METRICS_ID);
    fake.setFile(METRICS_ID, "docs/more.md", "# More\n");
    fake.updateRepo(METRICS_ID, { truncatedTree: true });
    await syncAll(ctx, { trigger: "manual" });
    expect(await repoRow(METRICS_ID)).toMatchObject({ syncStatus: "error", isOkf: true });
    expect((await repoRow(METRICS_ID))?.syncError).toMatch(/tree truncated/);
    expect(await docs(METRICS_ID)).toEqual(before);
  });

  it("a stale unchanged plan is re-planned once from the tree", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    await syncAll(ctx, { trigger: "manual" });
    fake.clearRequests();
    let poked = false;
    fake.onRequest = async (req) => {
      if (!poked && /^\/repos\/acme\/handbook\/branches\//.test(req.path)) {
        poked = true;
        // The stored row changes between planning and persisting.
        await h.db
          .update(repos)
          .set({ selectionFingerprint: "v1:someone-else" })
          .where(eq(repos.githubId, HANDBOOK_ID));
      }
    };
    const outcome = await syncRepoLocked(ctx, discovered(HANDBOOK_ID));
    fake.onRequest = null;
    expect(outcome.acquired && outcome.value.outcome).toBe("changed");
    expect(fake.requestsTo(TREES)).toHaveLength(1);
    expect(fake.requestsTo(BLOBS)).toHaveLength(0);
    expect((await repoRow(HANDBOOK_ID))?.selectionFingerprint).not.toBe("v1:someone-else");
  });

  it("syncRepoLocked returns busy while another holder has the repo lock", async () => {
    const fake = fixture();
    const ctx = ctxFor(fake);
    const repo = discovered(METRICS_ID);
    const inner = await withRepoSyncLock(h.pool, { githubId: METRICS_ID }, () =>
      syncRepoLocked(ctx, repo),
    );
    expect(inner.acquired && inner.value).toEqual({ acquired: false, reason: "busy" });
    const direct = await syncRepo(ctx, repo);
    expect(direct).toMatchObject({ outcome: "changed", unchanged: false });
  });

  it("never puts the installation token or the App key in rows, results or logs", async () => {
    const TOKEN = "ghs_SENTINELtoken9876543210abcdef";
    const fake = fixture([{ id: 808, name: "zeta", files: { "docs/z.md": "# Z\n" } }], TOKEN);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const outputs: unknown[] = [];
    try {
      const ctx = ctxFor(fake, { auth: "real" });
      const first = await syncAll(ctx, { trigger: "manual" });
      expect(first.run.ran && first.run.status).toBe("success");
      outputs.push(first);
      fake.setFile(HANDBOOK_ID, "docs/x.md", "# X\n");
      fake.fail({ path: /^\/repos\/acme\/handbook\/git\/trees\//, status: 500, times: 4 });
      fake.fail({
        path: /^\/repos\/acme\/zeta\/branches\//,
        status: 429,
        headers: { "retry-after": "3600" },
      });
      outputs.push(await syncAll(ctx, { trigger: "manual" }));
      outputs.push(await syncOne(ctx, { owner: OWNER, name: "metrics" }, { trigger: "webhook" }));
      fake.installationGone = true;
      outputs.push(await syncAll(ctxFor(fake, { auth: "real" }), { trigger: "manual" }));
      outputs.push(inspect(ctx, { depth: 10, showHidden: true }));
      // The failure paths really ran.
      const statuses = (await runs()).map((r) => r.status);
      expect(statuses).toEqual(["success", "failed", "success", "failed"]);

      const tables = await Promise.all([
        h.db.select().from(repos),
        h.db.select(docColumns).from(documents),
        h.db.select().from(codeOwners),
        h.db.select().from(syncRuns),
      ]);
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => inspect(c, { depth: 10 })));
      const haystack = [
        inspect(outputs, { depth: 20 }),
        JSON.stringify(outputs),
        JSON.stringify(tables),
        ...logged,
      ].join("\n");
      expect(fake.requests.some((r) => r.authorized)).toBe(true);
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain(PEM_SENTINEL);
      expect(haystack).not.toContain("PRIVATE KEY");
      expect(haystack).not.toMatch(/Bearer /);
      expect(haystack).not.toMatch(/eyJ[\w-]+\.[\w-]+\./); // no JWT
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  /** A discovered-repo record for direct `syncRepo` calls, read from the fake's listing. */
  function discovered(githubId: number) {
    const all = [handbook(), metrics()];
    const init = all.find((r) => r.id === githubId) as FakeRepoInit;
    return {
      githubId,
      owner: OWNER,
      name: init.name,
      defaultBranch: "main",
      visibility: init.visibility === "public" ? ("public" as const) : ("private" as const),
      archived: false,
      description: init.description ?? null,
      htmlUrl: `https://github.com/${OWNER}/${init.name}`,
      config: {},
    };
  }
});
