import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { configSchema, type AppConfigInput } from "../config/schema";
import { createDb, type DbHandle } from "../db/client";
import { documents, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { GitHubError, createGitHubClient } from "../github/client";
import { recordingLogger } from "../test-logger";
import { createSyncContext, syncAll, type SyncContext } from "./engine";
import { FakeGitHub, type FakeRepoInit, type RecordedRequest } from "./fake-github";
import {
  REMOVAL_UNCONFIRMED_MESSAGE,
  confirmRemovals,
  removalOutcomeEntry,
  type PlannedRemoval,
} from "./removal";

/**
 * Removal confirmation (hardening of task 5.9): a repo planned as `not_in_installation` is only
 * deleted when a second installation listing agrees it is gone, because the offset-paginated
 * listing can miss a repo when the installation's set shifts between pages.
 */

const planned = (
  githubId: number,
  reason: PlannedRemoval["reason"] = "not_in_installation",
): PlannedRemoval => ({ id: githubId, githubId, owner: "acme", name: `r${githubId}`, reason });

describe("confirmRemovals", () => {
  it("does not list again when no candidate needs confirmation", async () => {
    const list = vi.fn(async () => []);
    const rec = recordingLogger();
    const plan = [
      planned(1, "dropped_from_config"),
      planned(2, "archived"),
      planned(3, "excluded"),
    ];
    const result = await confirmRemovals(plan, list, rec.log);
    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({ confirmed: plan, unconfirmed: [] });
    expect(rec.records).toEqual([]);
  });

  it("confirms only candidates absent from the second listing, once", async () => {
    const list = vi.fn(async () => [{ id: 2 }, { id: 9 }]);
    const rec = recordingLogger();
    const plan = [planned(1), planned(2), planned(3, "dropped_from_config")];
    const result = await confirmRemovals(plan, list, rec.log);
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.confirmed.map((p) => p.githubId)).toEqual([1, 3]);
    expect(result.unconfirmed).toEqual([
      { repo: plan[1], status: "unconfirmed", documentsRemoved: 0, error: null },
    ]);
    expect(rec.find("sync.removal.unconfirmed")).toMatchObject([
      { githubId: 2, reason: "listed_again" },
    ]);
  });

  it("keeps every candidate when the second listing fails", async () => {
    const rec = recordingLogger();
    const plan = [planned(1), planned(2, "archived"), planned(3)];
    const result = await confirmRemovals(
      plan,
      async () => {
        throw new GitHubError("server", 502);
      },
      rec.log,
    );
    expect(result.confirmed.map((p) => p.githubId)).toEqual([2]);
    expect(result.unconfirmed.map((o) => [o.repo.githubId, o.status])).toEqual([
      [1, "unconfirmed"],
      [3, "unconfirmed"],
    ]);
    expect(rec.events()).toEqual([
      "sync.removal.confirm_failed",
      "sync.removal.unconfirmed",
      "sync.removal.unconfirmed",
    ]);
    expect(rec.find("sync.removal.unconfirmed")[0]).toMatchObject({ reason: "listing_failed" });
  });

  it("reports an unconfirmed removal as a skipped run entry", () => {
    expect(
      removalOutcomeEntry({
        repo: planned(7),
        status: "unconfirmed",
        documentsRemoved: 0,
        error: null,
      }),
    ).toMatchObject({
      status: "skipped",
      errorKind: "unconfirmed",
      error: REMOVAL_UNCONFIRMED_MESSAGE,
      removalReason: "not_in_installation",
      retryable: true,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Integration

const TARGET_ID = 7_000;
const OTHER_ID = 7_001;

function target(): FakeRepoInit {
  return {
    id: TARGET_ID,
    name: "target",
    files: { "docs/a.md": "# A\n\nAlpha.\n", "docs/b.md": "# B\n" },
  };
}

function other(): FakeRepoInit {
  return { id: OTHER_ID, name: "other", files: { "docs/o.md": "# O\n" } };
}

/** Empty repositories that fill the first listing page. Not in the config, never synced. */
function fillers(count: number, firstId = 1_000): FakeRepoInit[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    name: `filler-${i}`,
    defaultBranch: null,
  }));
}

const LISTING = "/installation/repositories";

describeDb("removal confirmation against a fixture-backed fake GitHub", () => {
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

  function ctxFor(fake: FakeGitHub, config: AppConfigInput): SyncContext {
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
    const rows = await h.db.select({ g: repos.githubId }).from(repos).orderBy(asc(repos.githubId));
    return rows.map((r) => r.g);
  }

  async function docCount(githubId: number): Promise<number> {
    const rows = await h.db
      .select({ path: documents.path })
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(eq(repos.githubId, githubId));
    return rows.length;
  }

  /** Runs `fn` before the n-th (1-based) listing page request, counted from now. */
  function beforeListingRequest(fake: FakeGitHub, actions: Record<number, () => void>): void {
    let n = 0;
    fake.onRequest = (request: RecordedRequest) => {
      if (request.path !== LISTING) return;
      n += 1;
      actions[n]?.();
    };
  }

  it("a repo missed because the set shifted between pages is not removed", async () => {
    // 100 fillers fill page 1; the target is the first repo of page 2.
    const fake = new FakeGitHub({ repos: [...fillers(100), target()] });
    const config = { repos: ["target"] };
    await syncAll(ctxFor(fake, config), { trigger: "manual" });
    expect(await storedIds()).toEqual([TARGET_ID]);
    expect(await docCount(TARGET_ID)).toBe(2);

    // Between page 1 and page 2 of the first listing: a filler on page 1 is removed and a new
    // repo is added. The total stays 101, page 2 now starts one repo later, so the target slides
    // onto page 1 (already read) and the walk sees 101 distinct repos without it.
    beforeListingRequest(fake, {
      2: () => {
        fake.removeRepo(1_005);
        fake.addRepo({ id: 9_999, name: "newcomer", defaultBranch: null });
      },
    });
    fake.clearRequests();
    const result = await syncAll(ctxFor(fake, config), { trigger: "manual" });

    // The first walk was consistent by its counts, so the run believed the target was gone...
    expect(result.discoveredGithubIds).toEqual([]);
    // ...but the confirmation listing still had it: kept, with its documents.
    expect(result.removals.map((r) => [r.repo.githubId, r.repo.reason, r.status])).toEqual([
      [TARGET_ID, "not_in_installation", "unconfirmed"],
    ]);
    expect(await storedIds()).toEqual([TARGET_ID]);
    expect(await docCount(TARGET_ID)).toBe(2);
    // One extra walk (two pages), no more.
    expect(fake.requestsTo(/^\/installation\/repositories$/)).toHaveLength(4);
    const entry = result.run.ran ? result.run.value.find((e) => e.githubId === TARGET_ID) : null;
    expect(entry).toMatchObject({ status: "skipped", errorKind: "unconfirmed" });

    // The next run sees a stable listing and syncs it as usual.
    fake.onRequest = null;
    const next = await syncAll(ctxFor(fake, config), { trigger: "manual" });
    expect(next.discoveredGithubIds).toEqual([TARGET_ID]);
    expect(next.removals).toEqual([]);
  });

  it("a second listing that contradicts the first keeps the repo", async () => {
    const fake = new FakeGitHub({ repos: [target(), other()] });
    await syncAll(ctxFor(fake, {}), { trigger: "manual" });
    expect(await storedIds()).toEqual([TARGET_ID, OTHER_ID]);

    // Gone for the run's listing, back for the confirmation listing.
    beforeListingRequest(fake, {
      1: () => fake.removeRepo(TARGET_ID),
      2: () => fake.addRepo(target()),
    });
    const result = await syncAll(ctxFor(fake, {}), { trigger: "manual" });
    expect(result.removals.map((r) => [r.repo.githubId, r.status])).toEqual([
      [TARGET_ID, "unconfirmed"],
    ]);
    expect(await storedIds()).toEqual([TARGET_ID, OTHER_ID]);
    expect(await docCount(TARGET_ID)).toBe(2);
  });

  it("removes only repos absent from both listings", async () => {
    const fake = new FakeGitHub({ repos: [target(), other()] });
    await syncAll(ctxFor(fake, {}), { trigger: "manual" });

    beforeListingRequest(fake, {
      1: () => {
        fake.removeRepo(TARGET_ID);
        fake.removeRepo(OTHER_ID);
      },
      2: () => fake.addRepo(target()),
    });
    const result = await syncAll(ctxFor(fake, {}), { trigger: "manual" });
    expect(result.removals.map((r) => [r.repo.githubId, r.status])).toEqual([
      [TARGET_ID, "unconfirmed"],
      [OTHER_ID, "removed"],
    ]);
    expect(await storedIds()).toEqual([TARGET_ID]);
    expect(await docCount(OTHER_ID)).toBe(0);
  });

  it("keeps the candidates when the confirmation listing fails", async () => {
    const fake = new FakeGitHub({ repos: [target(), other()] });
    await syncAll(ctxFor(fake, {}), { trigger: "manual" });

    beforeListingRequest(fake, {
      1: () => fake.removeRepo(TARGET_ID),
      2: () => fake.fail({ path: LISTING, status: 502 }),
    });
    const result = await syncAll(ctxFor(fake, {}), { trigger: "manual" });
    expect(result.removals.map((r) => [r.repo.githubId, r.status])).toEqual([
      [TARGET_ID, "unconfirmed"],
    ]);
    expect(await storedIds()).toEqual([TARGET_ID, OTHER_ID]);
  });

  it("lists only once when nothing needs confirmation", async () => {
    const fake = new FakeGitHub({ repos: [target(), other()] });
    await syncAll(ctxFor(fake, {}), { trigger: "manual" });

    // Unchanged installation: no candidates at all.
    fake.clearRequests();
    await syncAll(ctxFor(fake, {}), { trigger: "manual" });
    expect(fake.requestsTo(/^\/installation\/repositories$/)).toHaveLength(1);

    // Dropped from config: a removal, but decided from what the listing returned.
    fake.clearRequests();
    const result = await syncAll(ctxFor(fake, { repos: ["target"] }), { trigger: "manual" });
    expect(result.removals.map((r) => [r.repo.githubId, r.repo.reason, r.status])).toEqual([
      [OTHER_ID, "dropped_from_config", "removed"],
    ]);
    expect(fake.requestsTo(/^\/installation\/repositories$/)).toHaveLength(1);
  });
});
