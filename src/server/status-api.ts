import "server-only";

import { type Db, getDb } from "./db/client";
import { expectedFailureKind } from "./home";
import { getSyncStatus, type QueryOptions, type SyncRunCounts, type SyncStatus } from "./queries";
import { logger, type LogFn } from "./log";

/**
 * `GET /api/status` (task 12.2): the sync status as JSON for operators, scripts and health
 * checks. Admin-free on purpose: it shows exactly what the portal pages already show (sync state
 * of the visible repositories, the last run), through the same visibility filter
 * (`getSyncStatus`), and nothing more. The route file is a thin wrapper; the logic lives here.
 *
 * Body (`StatusResponse`):
 *   { generatedAt, running, lastRun, summary, repos, truncated }
 * Times are ISO 8601 strings. `repos` lists at most `MAX_STATUS_REPOS` (500) repositories by owner
 * then name; `truncated` is true when there are more (`summary.repos` counts all of them).
 *
 * Health checks: 200 means the app and its database answer; a failed repository sync does NOT
 * change the status code (read `summary.error` or `lastRun.status` for that). 503 means the
 * database or the configuration is unusable.
 *
 * Safety
 *  - Only `GET`; any other method is 405 with `Allow: GET`. The request body is never read, and
 *    query parameters are ignored.
 *  - No secrets and no internals: no GitHub ids, run ids, tree SHAs, fingerprints, ETags, rerun
 *    markers, locks or error stacks. Error texts are the fixed messages the sync stores.
 *  - `Cache-Control: no-store`, `nosniff`.
 *  - Any failure is `503 {"error":"unavailable"}`; the log line is a fixed message plus the error
 *    kind, never the error text or a connection detail. It never throws.
 *  - At most `MAX_IN_FLIGHT` status reads run at once in this process (more get 503 with
 *    `Retry-After`): a safety valve, not rate limiting (that belongs in the reverse proxy).
 */

export const MAX_IN_FLIGHT = 4;

export const UNAVAILABLE_STATUS_BODY = { error: "unavailable" } as const;

export interface StatusApiDeps {
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
  readonly db?: () => Db;
  readonly now?: () => Date;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
  /** Query options (tests swap the visibility filter to prove the shared layer is used). */
  readonly options?: QueryOptions;
  /** Concurrency cap. Default `MAX_IN_FLIGHT`. */
  readonly maxInFlight?: number;
}

export interface StatusResponse {
  readonly generatedAt: string;
  readonly running: { trigger: string; scope: string | null; startedAt: string } | null;
  readonly lastRun: {
    trigger: string;
    scope: string | null;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
    counts: SyncRunCounts;
  } | null;
  readonly summary: {
    repos: number;
    ok: number;
    error: number;
    pending: number;
    withWarnings: number;
  };
  readonly repos: {
    owner: string;
    name: string;
    visibility: string;
    syncStatus: string;
    syncError: string | null;
    lastSyncedAt: string | null;
    warnings: { code: string; message: string; count: number }[];
    skippedFiles: number;
  }[];
  readonly truncated: boolean;
}

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  Vary: "Cookie, Authorization, Accept-Encoding",
  "X-Content-Type-Options": "nosniff",
} as const;

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers = new Headers(BASE_HEADERS);
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function unavailable(extra?: Record<string, string>): Response {
  return json(UNAVAILABLE_STATUS_BODY, 503, extra);
}

/** 405 for every method but GET, before anything is read. */
export function statusMethodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The response body for a status read. Pure; exported for tests. */
export function statusBody(sync: SyncStatus, now: Date): StatusResponse {
  const last = sync.lastRun;
  return {
    generatedAt: now.toISOString(),
    running:
      sync.running === null
        ? null
        : {
            trigger: sync.running.trigger,
            scope: sync.running.scope,
            startedAt: sync.running.startedAt.toISOString(),
          },
    lastRun:
      last === null
        ? null
        : {
            trigger: last.trigger,
            scope: last.scope,
            status: last.status,
            startedAt: last.startedAt.toISOString(),
            finishedAt: iso(last.finishedAt),
            durationMs: last.durationMs,
            error: last.error,
            counts: last.counts,
          },
    summary: {
      repos: sync.reposTotal,
      ok: sync.reposByStatus.ok,
      error: sync.reposByStatus.error,
      pending: sync.reposByStatus.pending,
      withWarnings: sync.reposWithWarnings,
    },
    repos: sync.repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      visibility: r.visibility,
      syncStatus: r.syncStatus,
      syncError: r.syncError,
      lastSyncedAt: iso(r.lastSyncedAt),
      warnings: r.warnings.map((w) => ({ code: w.code, message: w.message, count: w.count })),
      skippedFiles: r.skippedFiles,
    })),
    truncated: sync.truncated,
  };
}

let inFlight = 0;

export async function handleStatusRequest(
  request: Request,
  deps: StatusApiDeps = {},
): Promise<Response> {
  if (request.method !== "GET") return statusMethodNotAllowed();
  const log = deps.log ?? logger.error;
  const now = deps.now ?? (() => new Date());
  if (inFlight >= (deps.maxInFlight ?? MAX_IN_FLIGHT)) return unavailable({ "Retry-After": "1" });
  inFlight += 1;
  try {
    const db = (deps.db ?? (() => getDb().db))();
    const sync = await getSyncStatus(db, {}, deps.options);
    return json(statusBody(sync, now()));
  } catch (error) {
    let kind: string | null = null;
    try {
      kind = expectedFailureKind(error);
    } catch {
      // classification must not break the answer
    }
    try {
      log("status_api.failed", { reason: kind ?? "unexpected error" });
    } catch {
      // a failing logger must not break the answer
    }
    return unavailable();
  } finally {
    inFlight -= 1;
  }
}
