import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { configSchema, type AppConfigInput } from "@docmyrepos/core/internal/config/schema";
import { withRepoSyncLock } from "../db/advisory-lock";
import { createDb, type DbHandle } from "../db/client";
import { SEARCH_TEXT_CONFIG, codeOwners, documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { GitHubError, createGitHubClient } from "../github/client";
import type { DiscoveryResult } from "./discovery";
import { createSyncContext, syncAll, syncOne, type SyncContext } from "./engine";
import { FakeGitHub, type FakeRepoInit } from "../../../../tests/support/fake-github";
import {
  REMOVAL_BUSY_MESSAGE,
  REMOVAL_CHANGED_MESSAGE,
  databaseNow,
  executeRemovals,
  planRemovals,
  readStoredRepos,
  removalOutcomeEntry,
  removeRepo,
  type PlannedRemoval,
  type StoredRepoRef,
} from "./removal";

// ---------------------------------------------------------------------------------------------
// Unit: planRemovals

const stored = (githubId: number, name: string, id = githubId): StoredRepoRef => ({
  id,
  githubId,
  owner: "acme",
  name,
});

function listed(
  repos: { githubId: number; name: string }[],
  skipped: { githubId: number; name: string; reason: "archived" | "excluded" }[] = [],
): DiscoveryResult {
  return {
    complete: true,
    repos: repos.map((r) => ({
      ...r,
      owner: "acme",
      defaultBranch: "main",
      visibility: "public",
      archived: false,
      description: null,
      htmlUrl: `https://github.com/acme/${r.name}`,
      config: {},
    })),
    skipped: skipped.map((s) => ({ ...s, owner: "acme" })),
    inaccessible: [],
  };
}

describe("planRemovals", () => {
  it("plans nothing when the listing was not complete", () => {
    for (const kind of ["server", "installation_unavailable", "not_found"] as const) {
      const discovery: DiscoveryResult = {
        complete: false,
        error: new GitHubError(kind, 502),
        repos: [],
        skipped: [],
        inaccessible: [],
      };
      expect(
        planRemovals({ stored: [stored(1, "a"), stored(2, "b")], discovery, config: {} }),
      ).toEqual([]);
    }
  });

  it("keeps discovered repos and gives a reason for every other stored repo", () => {
    const plan = planRemovals({
      stored: [
        stored(1, "kept"),
        stored(2, "gone"),
        stored(3, "sandbox"),
        stored(4, "old"),
        stored(5, "Renamed-Kept"),
      ],
      discovery: listed(
        [
          { githubId: 1, name: "kept" },
          { githubId: 5, name: "renamed-kept-now" },
        ],
        [
          { githubId: 3, name: "sandbox", reason: "excluded" },
          { githubId: 4, name: "old", reason: "archived" },
        ],
      ),
      config: { exclude: ["sandbox"] },
    });
    expect(plan.map((p) => [p.githubId, p.reason])).toEqual([
      [2, "not_in_installation"],
      [3, "excluded"],
      [4, "archived"],
    ]);
    expect(plan[0]).toEqual({
      id: 2,
      githubId: 2,
      owner: "acme",
      name: "gone",
      reason: "not_in_installation",
    });
  });

  it("with an explicit repos list: unlisted is dropped_from_config, listed but absent is not_in_installation", () => {
    const plan = planRemovals({
      stored: [stored(1, "handbook"), stored(2, "metrics"), stored(3, "Ghost")],
      discovery: listed([{ githubId: 1, name: "handbook" }]),
      config: { repos: ["handbook", { name: "ghost", docsPath: "x" }] },
    });
    expect(plan.map((p) => [p.name, p.reason])).toEqual([
      ["metrics", "dropped_from_config"],
      ["Ghost", "not_in_installation"],
    ]);
  });

  it("an empty database or an unchanged selection plans nothing", () => {
    expect(planRemovals({ stored: [], discovery: listed([]), config: {} })).toEqual([]);
    expect(
      planRemovals({
        stored: [stored(1, "a")],
        discovery: listed([{ githubId: 1, name: "a" }]),
        config: {},
      }),
    ).toEqual([]);
  });

  it("an empty but complete listing removes everything stored", () => {
    expect(
      planRemovals({ stored: [stored(1, "a")], discovery: listed([]), config: {} }).map(
        (p) => p.reason,
      ),
    ).toEqual(["not_in_installation"]);
  });
});

describe("removalOutcomeEntry", () => {
  const repo: PlannedRemoval = { ...stored(9, "x"), reason: "archived" };
  it("maps each outcome to a results entry carrying the reason", () => {
    expect(
      removalOutcomeEntry({ repo, status: "removed", documentsRemoved: 3, error: null }),
    ).toMatchObject({
      repo: "acme/x",
      githubId: 9,
      status: "removed",
      removed: 3,
      removalReason: "archived",
      error: null,
    });
    expect(
      removalOutcomeEntry({ repo, status: "busy", documentsRemoved: 0, error: null }),
    ).toMatchObject({ status: "skipped", errorKind: "busy", error: REMOVAL_BUSY_MESSAGE });
    expect(
      removalOutcomeEntry({ repo, status: "changed", documentsRemoved: 0, error: null }),
    ).toMatchObject({ status: "skipped", errorKind: "changed", error: REMOVAL_CHANGED_MESSAGE });
    expect(
      removalOutcomeEntry({
        repo,
        status: "error",
        documentsRemoved: 0,
        error: { kind: "database", message: "db", retryable: true, retryAt: null, fatal: false },
      }),
    ).toMatchObject({ status: "error", errorKind: "database", removalReason: "archived" });
  });
});

// ---------------------------------------------------------------------------------------------
// Integration: real client over the fake GitHub, real test database

const OWNER = "acme";
const HANDBOOK_ID = 101;
const METRICS_ID = 202;
const SANDBOX_ID = 303;

function handbook(): FakeRepoInit {
  return {
    id: HANDBOOK_ID,
    name: "handbook",
    visibility: "private",
    files: {
      "README.md": "# Handbook\n",
      CODEOWNERS: "* @acme/docs-team\n",
      "docs/getting-started.md": "# Getting Started\n\nWelcome aboard.\n",
      "docs/deploy.md": "# Deploy\n\nShip it.\n",
    },
  };
}

function metrics(): FakeRepoInit {
  return {
    id: METRICS_ID,
    name: "metrics",
    files: {
      CODEOWNERS: "*.md @acme/analysts\n/docs/ @bob\n",
      "docs/index.md": '---\nokf_version: "0.2"\n---\n\n# Metrics\n',
      "docs/revenue.md":
        "---\ntype: Metric\ntags: [finance]\n---\n\n# Revenue\n\nRevenue welcome.\n",
      "docs/churn.md": "---\ntype: Metric\n---\n\n# Churn\n",
    },
  };
}

function sandbox(): FakeRepoInit {
  return { id: SANDBOX_ID, name: "sandbox", files: { "docs/s.md": "# Sandbox\n" } };
}

function fixture(): FakeGitHub {
  return new FakeGitHub({ owner: OWNER, repos: [handbook(), metrics(), sandbox()] });
}

describeDb("repo removal against a fixture-backed fake GitHub", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;

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
  });

  function ctxFor(fake: FakeGitHub, config: AppConfigInput = {}): SyncContext {
    const github = createGitHubClient({
      getToken: fake.getToken,
      fetch: fake.fetch,
      sleep: async () => undefined,
      maxWaitMs: 1_000,
    });
    return createSyncContext({
      db: h.db,
      pool: h.pool,
      github,
      config: configSchema.parse(config),
    });
  }

  async function storedIds(): Promise<number[]> {
    return (await h.db.select({ g: repos.githubId }).from(repos).orderBy(asc(repos.githubId))).map(
      (r) => r.g,
    );
  }

  /** Rows of each table that belong to the repo with this GitHub id (joined or by repo_id). */
  async function footprint(githubId: number) {
    const [row] = await h.db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.githubId, githubId));
    const repoId = row?.id ?? -1;
    const docRows = await h.db
      .select({ path: documents.path })
      .from(documents)
      .where(eq(documents.repoId, repoId));
    const ownerRows = await h.db
      .select({ p: codeOwners.position })
      .from(codeOwners)
      .where(eq(codeOwners.repoId, repoId));
    return { repo: row !== undefined, docs: docRows.length, owners: ownerRows.length, repoId };
  }

  async function orphanCounts() {
    const result = await h.db.execute<{ docs: string; owners: string }>(sql`
      select
        (select count(*) from documents d where not exists (select 1 from repos r where r.id = d.repo_id)) as docs,
        (select count(*) from code_owners c where not exists (select 1 from repos r where r.id = c.repo_id)) as owners`);
    return { docs: Number(result.rows[0]?.docs), owners: Number(result.rows[0]?.owners) };
  }

  /** Full-text search the way the portal will (websearch_to_tsquery), returning owner/name:path. */
  async function search(q: string): Promise<string[]> {
    const result = await h.db.execute<{ hit: string }>(sql`
      select r.owner || '/' || r.name || ':' || d.path as hit
      from documents d join repos r on r.id = d.repo_id
      where d.search_vector @@ websearch_to_tsquery(${SEARCH_TEXT_CONFIG}::regconfig, ${q})
      order by hit`);
    return result.rows.map((r) => r.hit);
  }

  async function lastRun() {
    const rows = await h.db.select().from(syncRuns).orderBy(asc(syncRuns.id));
    return { last: rows[rows.length - 1], count: rows.length };
  }

  it("first run on an empty database removes nothing", async () => {
    const fake = fixture();
    const result = await syncAll(ctxFor(fake), { trigger: "startup" });
    expect(result.removals).toEqual([]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID, SANDBOX_ID]);
    const { last } = await lastRun();
    expect(last?.results.some((r) => r.status === "removed")).toBe(false);
  });

  it("a repo dropped from config disappears with its documents and code owners; others and search intact", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    const handbookBefore = await footprint(HANDBOOK_ID);
    const metricsBefore = await footprint(METRICS_ID);
    expect(metricsBefore).toMatchObject({ repo: true, docs: 3, owners: 2 });
    expect(await search("welcome")).toEqual([
      "acme/handbook:docs/getting-started.md",
      "acme/metrics:docs/revenue.md",
    ]);
    expect(await search("revenue")).toEqual(["acme/metrics:docs/revenue.md"]);

    const result = await syncAll(ctxFor(fake, { repos: ["handbook"] }), { trigger: "manual" });
    expect(result.run.ran && result.run.status).toBe("success");
    expect(result.removals.map((r) => [r.repo.githubId, r.repo.reason, r.status])).toEqual([
      [METRICS_ID, "dropped_from_config", "removed"],
      [SANDBOX_ID, "dropped_from_config", "removed"],
    ]);

    // Gone from every query: repos, documents, code owners, search.
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: false, docs: 0, owners: 0 });
    const byOldId = await h.db
      .select({ path: documents.path })
      .from(documents)
      .where(eq(documents.repoId, metricsBefore.repoId));
    expect(byOldId).toEqual([]);
    expect(
      await h.db.select().from(codeOwners).where(eq(codeOwners.repoId, metricsBefore.repoId)),
    ).toEqual([]);
    expect(await orphanCounts()).toEqual({ docs: 0, owners: 0 });
    expect(await search("revenue")).toEqual([]);
    expect(await search("welcome")).toEqual(["acme/handbook:docs/getting-started.md"]);
    // The others are untouched.
    expect(await footprint(HANDBOOK_ID)).toEqual(handbookBefore);
    expect(await storedIds()).toEqual([HANDBOOK_ID]);

    // Recorded in the run; earlier runs survive (no FK from sync_runs).
    const { last, count } = await lastRun();
    expect(count).toBe(2);
    expect(last).toMatchObject({ status: "success", reposTotal: 1, docsRemoved: 3 + 1 });
    expect(
      last?.results.map((r) => [r.githubId, r.status, r.removalReason ?? null, r.removed]),
    ).toEqual([
      [HANDBOOK_ID, "unchanged", null, 0],
      [METRICS_ID, "removed", "dropped_from_config", 3],
      [SANDBOX_ID, "removed", "dropped_from_config", 1],
    ]);
  });

  it("a repo removed from the installation (or deleted on GitHub) is removed", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.removeRepo(METRICS_ID);
    const result = await syncAll(ctxFor(fake), { trigger: "schedule" });
    expect(result.removals.map((r) => [r.repo.githubId, r.repo.reason, r.status])).toEqual([
      [METRICS_ID, "not_in_installation", "removed"],
    ]);
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: false, docs: 0, owners: 0 });
    expect(await storedIds()).toEqual([HANDBOOK_ID, SANDBOX_ID]);
    expect((await lastRun()).last).toMatchObject({ status: "success" });
  });

  it("a repo deleted and recreated under the same name replaces the old row", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.removeRepo(METRICS_ID);
    fake.addRepo({ id: 909, name: "metrics", files: { "docs/new.md": "# New\n" } });
    await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(await storedIds()).toEqual([HANDBOOK_ID, SANDBOX_ID, 909]);
    expect(await footprint(909)).toMatchObject({ repo: true, docs: 1 });
    expect(await orphanCounts()).toEqual({ docs: 0, owners: 0 });
  });

  it("a failed listing (502 or installation 404) deletes nothing", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.removeRepo(METRICS_ID);
    for (const status of [502, 404]) {
      fake.clearFailures();
      fake.fail({ path: "/installation/repositories", status });
      const result = await syncAll(ctxFor(fake, { repos: ["handbook"] }), { trigger: "manual" });
      expect(result.discovery?.complete).toBe(false);
      expect(result.removals).toEqual([]);
      expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID, SANDBOX_ID]);
      expect(await footprint(METRICS_ID)).toMatchObject({ docs: 3, owners: 2 });
    }
    // An uninstalled App is the same.
    fake.clearFailures();
    fake.installationGone = true;
    await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID, SANDBOX_ID]);
  });

  it("a listed repo whose tree fetch fails is not removed and keeps its content", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.setFile(METRICS_ID, "docs/x.md", "# X\n");
    fake.fail({ path: /^\/repos\/acme\/metrics\/git\/trees\//, status: 500 });
    const result = await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(result.removals).toEqual([]);
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: true, docs: 3, owners: 2 });
    const [row] = await h.db.select().from(repos).where(eq(repos.githubId, METRICS_ID));
    expect(row?.syncStatus).toBe("error");
  });

  it("a repo whose branch head 404s (transient) is not removed", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.setFile(METRICS_ID, "docs/x.md", "# X\n");
    fake.fail({ path: /^\/repos\/acme\/metrics\/branches\//, status: 404 });
    await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: true, docs: 3 });
  });

  it("an excluded repo is removed", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    const result = await syncAll(ctxFor(fake, { exclude: ["Sandbox"] }), { trigger: "manual" });
    expect(result.removals.map((r) => [r.repo.githubId, r.repo.reason, r.status])).toEqual([
      [SANDBOX_ID, "excluded", "removed"],
    ]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID]);
  });

  it("a repo archived upstream is removed, and comes back when unarchived", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.updateRepo(METRICS_ID, { archived: true });
    const result = await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(result.removals.map((r) => [r.repo.githubId, r.repo.reason, r.status])).toEqual([
      [METRICS_ID, "archived", "removed"],
    ]);
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: false, docs: 0, owners: 0 });

    fake.updateRepo(METRICS_ID, { archived: false });
    await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: true, docs: 3, owners: 2 });
  });

  it("a busy repo is skipped and removed on the next run", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.removeRepo(METRICS_ID);
    const held = await withRepoSyncLock(h.pool, { githubId: METRICS_ID }, () =>
      syncAll(ctxFor(fake), { trigger: "manual" }),
    );
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    expect(held.value.removals.map((r) => r.status)).toEqual(["busy"]);
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: true, docs: 3 });
    const first = (await lastRun()).last;
    expect(first?.status).toBe("success");
    expect(first?.results.find((r) => r.githubId === METRICS_ID)).toMatchObject({
      status: "skipped",
      errorKind: "busy",
      error: REMOVAL_BUSY_MESSAGE,
      removalReason: "not_in_installation",
    });

    const next = await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(next.removals.map((r) => r.status)).toEqual(["removed"]);
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: false, docs: 0 });
  });

  it("a repo added concurrently after the listing is not removed", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    let poked = false;
    fake.onRequest = async (req) => {
      if (!poked && req.path === "/installation/repositories") {
        poked = true;
        // A webhook-driven sync stores a newly installed repo while this run lists.
        await h.db.insert(repos).values({
          githubId: 999,
          owner: OWNER,
          name: "fresh",
          defaultBranch: "main",
          visibility: "public",
          htmlUrl: "https://github.com/acme/fresh",
        });
        // And re-syncs a stored one that this listing (wrongly, by timing) lacks.
        fake.removeRepo(SANDBOX_ID);
        await h.db
          .update(repos)
          .set({ updatedAt: sql`now() + interval '1 second'` })
          .where(eq(repos.githubId, SANDBOX_ID));
      }
    };
    const result = await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.onRequest = null;
    expect(result.removals.map((r) => [r.repo.githubId, r.status])).toEqual([
      [SANDBOX_ID, "changed"],
      [999, "changed"],
    ]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID, SANDBOX_ID, 999]);
    expect((await lastRun()).last?.results.filter((r) => r.errorKind === "changed")).toHaveLength(
      2,
    );
  });

  it("executeRemovals never deletes a row whose GitHub id this run discovered", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    const rows = await readStoredRepos(h.db);
    const planned: PlannedRemoval[] = rows.map((r) => ({ ...r, reason: "not_in_installation" }));
    const listedAt = await databaseNow(h.db);
    const outcomes = await executeRemovals(h.db, h.pool, planned, {
      discoveredGithubIds: [HANDBOOK_ID, METRICS_ID],
      listedAt,
    });
    expect(outcomes.map((o) => [o.repo.githubId, o.status, o.documentsRemoved])).toEqual([
      [HANDBOOK_ID, "changed", 0],
      [METRICS_ID, "changed", 0],
      [SANDBOX_ID, "removed", 1],
    ]);
    // A planned row whose id changed meanwhile (stale plan) is not deleted.
    const stale = await executeRemovals(
      h.db,
      h.pool,
      [{ ...stored(HANDBOOK_ID, "handbook", 12345), reason: "archived" }],
      { discoveredGithubIds: [], listedAt },
    );
    expect(stale.map((o) => o.status)).toEqual(["changed"]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID]);
    // An aborted run removes nothing more.
    const controller = new AbortController();
    controller.abort();
    const aborted = await executeRemovals(h.db, h.pool, [{ ...rows[0]!, reason: "archived" }], {
      discoveredGithubIds: [],
      listedAt: await databaseNow(h.db),
      signal: controller.signal,
    });
    expect(aborted.map((o) => o.status)).toEqual(["aborted"]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID]);
  });

  it("syncOne not_found deletes nothing", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.removeRepo(METRICS_ID);
    expect(
      (await syncOne(ctxFor(fake), { githubId: METRICS_ID }, { trigger: "webhook" })).status,
    ).toBe("not_found");
    expect(
      (await syncOne(ctxFor(fake), { owner: OWNER, name: "metrics" }, { trigger: "webhook" }))
        .status,
    ).toBe("not_found");
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: true, docs: 3, owners: 2 });
  });

  it("a rate-limited run still removes; an installation-wide failure mid-run does not", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    fake.removeRepo(SANDBOX_ID);
    fake.setFile(HANDBOOK_ID, "docs/x.md", "# X\n");
    fake.fail({ path: /\/branches\//, status: 401 });
    const unauthorized = await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(unauthorized.run.ran && unauthorized.run.status).toBe("failed");
    expect(unauthorized.removals).toEqual([]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID, SANDBOX_ID]);

    fake.clearFailures();
    fake.fail({
      path: /\/branches\//,
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
    const limited = await syncAll(ctxFor(fake), { trigger: "manual" });
    expect(limited.run.ran && limited.run.status).toBe("failed");
    expect(limited.removals.map((r) => [r.repo.githubId, r.status])).toEqual([
      [SANDBOX_ID, "removed"],
    ]);
    expect(await storedIds()).toEqual([HANDBOOK_ID, METRICS_ID]);
  });

  it("removeRepo deletes one repo by id or name (case-insensitive) with its documents", async () => {
    const fake = fixture();
    await syncAll(ctxFor(fake), { trigger: "manual" });
    const runsBefore = (await lastRun()).count;

    const byId = await removeRepo(h.db, h.pool, { githubId: METRICS_ID }, "deleted");
    expect(byId).toMatchObject({
      status: "removed",
      reason: "deleted",
      documentsRemoved: 3,
      repo: { githubId: METRICS_ID, owner: OWNER, name: "metrics" },
    });
    expect(await footprint(METRICS_ID)).toMatchObject({ repo: false, docs: 0, owners: 0 });
    expect(await search("revenue")).toEqual([]);
    expect(await search("welcome")).toEqual(["acme/handbook:docs/getting-started.md"]);

    expect(
      await removeRepo(h.db, h.pool, { owner: "ACME", name: "SandBox" }, "not_in_installation"),
    ).toMatchObject({ status: "removed", documentsRemoved: 1 });
    expect(await removeRepo(h.db, h.pool, { githubId: METRICS_ID }, "deleted")).toEqual({
      status: "not_found",
    });
    expect(await removeRepo(h.db, h.pool, { owner: OWNER, name: "nope" }, "deleted")).toEqual({
      status: "not_found",
    });

    // Busy while another sync holds the repo.
    const held = await withRepoSyncLock(h.pool, { githubId: HANDBOOK_ID }, () =>
      removeRepo(h.db, h.pool, { githubId: HANDBOOK_ID }, "archived"),
    );
    expect(held.acquired && held.value).toEqual({ status: "busy" });
    expect(await storedIds()).toEqual([HANDBOOK_ID]);

    await expect(removeRepo(h.db, h.pool, { githubId: 0 }, "deleted")).rejects.toThrow(TypeError);
    await expect(removeRepo(h.db, h.pool, { owner: "", name: "x" }, "deleted")).rejects.toThrow(
      TypeError,
    );
    // sync_runs are untouched by removal.
    expect((await lastRun()).count).toBe(runsBefore);
  });
});
