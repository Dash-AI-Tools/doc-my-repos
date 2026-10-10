import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/load";
import type { Db } from "./db/client";
import { repos, syncRuns, type SyncRepoResult } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { publicReposOnly } from "./queries/visibility";
import {
  handleStatusRequest,
  MAX_IN_FLIGHT,
  statusMethodNotAllowed,
  UNAVAILABLE_STATUS_BODY,
} from "./status-api";

const NOW = new Date("2026-10-10T12:00:00Z");
const get = (init?: RequestInit) => new Request("http://localhost/api/status", init);

/** Text that must never reach a response or a log line. */
const SECRET = "postgres://user:sentinel-password@10.1.2.3:5432/db";

function failingDb(error: unknown): Db {
  return {
    execute() {
      throw error;
    },
    select() {
      throw error;
    },
  } as unknown as Db;
}

function osError(code: string): Error {
  return Object.assign(new Error(`connect failed to ${SECRET}`), { code });
}

describe("GET /api/status without a database", () => {
  it("refuses other methods with 405 and Allow: GET, before any read", async () => {
    const db = vi.fn(() => failingDb(new Error("must not be used")));
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const res = await handleStatusRequest(get({ method }), { db });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect(db).not.toHaveBeenCalled();
    expect(statusMethodNotAllowed().status).toBe(405);
  });

  it.each([
    ["an unreachable database", osError("ECONNREFUSED"), "database error (ECONNREFUSED)"],
    ["a configuration error", new ConfigError([`DATABASE_URL: ${SECRET}`]), "ConfigError"],
    ["an unexpected error", new Error(`boom ${SECRET}`), "unexpected error"],
  ])("answers %s with a fixed 503 and logs only the kind", async (_name, error, kind) => {
    const log = vi.fn();
    const res = await handleStatusRequest(get(), { db: () => failingDb(error), log });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE_STATUS_BODY);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(log).toHaveBeenCalledWith(`[status-api] could not read the sync status: ${kind}`);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sentinel");
  });

  it("answers a runtime that cannot be built (ConfigError thrown by the db factory)", async () => {
    const res = await handleStatusRequest(get(), {
      db: () => {
        throw new ConfigError([`GITHUB_APP_PRIVATE_KEY: ${SECRET}`]);
      },
      log: () => undefined,
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"unavailable"}');
  });

  it("survives a logger that throws", async () => {
    const res = await handleStatusRequest(get(), {
      db: () => failingDb(osError("ECONNREFUSED")),
      log: () => {
        throw new Error("logger down");
      },
    });
    expect(res.status).toBe(503);
  });

  it("refuses reads beyond the in-process concurrency cap, with Retry-After", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      select() {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: async () => (await gate, []) }),
            }),
          }),
        };
      },
    } as unknown as Db;
    const pending = Array.from({ length: MAX_IN_FLIGHT }, () =>
      handleStatusRequest(get(), { db: () => slow, log: () => undefined }),
    );
    const extra = await handleStatusRequest(get(), { db: () => slow, log: () => undefined });
    expect(extra.status).toBe(503);
    expect(extra.headers.get("retry-after")).toBe("1");
    release();
    await Promise.all(pending);
  });
});

function entry(githubId: number, repo: string, extra: Partial<SyncRepoResult> = {}) {
  return {
    repo,
    githubId,
    status: "ok",
    error: null,
    errorKind: null,
    retryable: false,
    retryAfter: null,
    added: 0,
    updated: 0,
    identical: 0,
    removed: 0,
    skipped: 0,
    skippedFiles: [],
    failedFiles: [],
    failedFilesTotal: 0,
    warnings: [],
    warningsTotal: 0,
    replacedRepos: [],
    ...extra,
  } satisfies SyncRepoResult;
}

describeDb("GET /api/status on a real database", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    const base = {
      defaultBranch: "main",
      treeSha: "sentinel-tree-sha",
      selectionFingerprint: "v2:sentinel-fp",
    };
    await t.db.insert(repos).values([
      {
        ...base,
        githubId: 11,
        owner: "acme",
        name: "api",
        visibility: "public",
        htmlUrl: "https://github.com/acme/api",
        syncStatus: "ok",
        lastSyncedAt: new Date("2026-10-10T11:00:00Z"),
        headEtag: '"sentinel-etag"',
        syncRequestedAt: new Date(),
        syncWarnings: [
          {
            code: "docs_capped",
            message: "Only the first 2 of 3 documentation files were synced.",
            count: 1,
            paths: ["docs/c.md"],
          },
        ],
      },
      {
        ...base,
        githubId: 12,
        owner: "acme",
        name: "flaky",
        visibility: "public",
        htmlUrl: "https://github.com/acme/flaky",
        syncStatus: "error",
        syncError: "GitHub rate limit exhausted; retry later",
        lastSyncedAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        ...base,
        githubId: 13,
        owner: "acme",
        name: "hidden-tools",
        visibility: "private",
        htmlUrl: "https://github.com/acme/hidden-tools",
        syncStatus: "ok",
      },
    ]);
    await t.db.insert(syncRuns).values({
      trigger: "webhook",
      scope: null,
      status: "partial",
      startedAt: new Date("2026-10-10T11:00:00Z"),
      finishedAt: new Date("2026-10-10T11:00:02.500Z"),
      results: [
        entry(11, "acme/api", { added: 2, skipped: 1, warningsTotal: 1 }),
        entry(12, "acme/flaky", {
          status: "error",
          error: "GitHub rate limit exhausted; retry later",
        }),
        entry(13, "acme/hidden-tools", { added: 9 }),
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("answers the sync status as JSON, with an errored repository and no internals", async () => {
    const res = await handleStatusRequest(get(), { db: () => t.db, now: () => NOW });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toEqual({
      generatedAt: "2026-10-10T12:00:00.000Z",
      running: null,
      lastRun: {
        trigger: "webhook",
        scope: null,
        status: "partial",
        startedAt: "2026-10-10T11:00:00.000Z",
        finishedAt: "2026-10-10T11:00:02.500Z",
        durationMs: 2500,
        error: null,
        counts: {
          repos: 3,
          ok: 2,
          failed: 1,
          skipped: 0,
          docsAdded: 11,
          docsUpdated: 0,
          docsRemoved: 0,
          docsSkipped: 1,
          warnings: 1,
        },
      },
      summary: { repos: 3, ok: 2, error: 1, pending: 0, withWarnings: 1 },
      repos: [
        {
          owner: "acme",
          name: "api",
          visibility: "public",
          syncStatus: "ok",
          syncError: null,
          lastSyncedAt: "2026-10-10T11:00:00.000Z",
          warnings: [
            {
              code: "docs_capped",
              message: "Only the first 2 of 3 documentation files were synced.",
              count: 1,
            },
          ],
          skippedFiles: 1,
        },
        {
          owner: "acme",
          name: "flaky",
          visibility: "public",
          syncStatus: "error",
          syncError: "GitHub rate limit exhausted; retry later",
          lastSyncedAt: "2026-10-01T00:00:00.000Z",
          warnings: [],
          skippedFiles: 0,
        },
        {
          owner: "acme",
          name: "hidden-tools",
          visibility: "private",
          syncStatus: "ok",
          syncError: null,
          lastSyncedAt: null,
          warnings: [],
          skippedFiles: 0,
        },
      ],
      truncated: false,
    });
    expect(text).not.toMatch(/sentinel|githubId|github_id|runId|treeSha|etag|requested/i);
  });

  it("goes through the shared visibility filter", async () => {
    const res = await handleStatusRequest(get(), {
      db: () => t.db,
      options: { visibility: publicReposOnly },
    });
    const text = await res.text();
    expect(text).not.toContain("hidden-tools");
    const body = JSON.parse(text);
    expect(body.summary.repos).toBe(2);
    expect(body.lastRun.counts).toMatchObject({ repos: 2, docsAdded: 2 });
  });
});
