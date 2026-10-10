import { and, asc, count, eq, lte, notInArray, sql, type SQL } from "drizzle-orm";
import type { Pool } from "pg";

import { withRepoSyncLock } from "../db/advisory-lock";
import type { Db } from "../db/client";
import { documents, repos, type RepoRemovalReason, type SyncRepoResult } from "../db/schema";
import type { DiscoveryConfig, DiscoveryResult } from "./discovery";
import { describeSyncError, failureEntry, removalEntry, type SyncErrorInfo } from "./runs";

/**
 * Removal of stored repositories (task 5.9), following the design's removal rule: DELETE the repo
 * row (cascading to documents and code owners; `sync_runs` has no FK and is untouched) when it is
 * absent from a successful FULL installation listing, dropped from config, or confirmed gone
 * upstream. Never on a listing failure, partial pagination, a transient 404 or a failed repo fetch:
 * those keep the stored content and mark the repo `error` (runs.ts / engine.ts).
 *
 * - `planRemovals` (pure) decides from the stored rows, a discovery result and the config. It
 *   returns nothing unless `discovery.complete` is true. A repo still in `discovery.repos` is never
 *   planned, even if its sync failed this run.
 * - `executeRemovals` deletes the planned rows, one transaction per repo under that repo's sync
 *   lock (try mode: a busy repo is skipped and re-planned next run). The DELETE re-checks, inside
 *   the transaction, that the row still has the planned GitHub id, that the id is not one this run
 *   discovered, and that no sync wrote the row after the listing was taken (`updated_at <=
 *   listedAt`; every successful persist sets `updated_at = now()`, and so does a `privatized`
 *   webhook), so a repo re-added, re-synced or privatized concurrently by a webhook is not deleted
 *   on stale information.
 * - `removeRepo` deletes one repo on an authoritative signal (task 6.3 webhooks).
 *
 * Archived repos: config-and-sources says every NON-archived accessible repo is "synced and
 * shown" and archived ones are skipped, so a stored repo archived upstream leaves the shown set and
 * is removed (`archived`). Unarchiving brings it back on the next sync.
 */

export const REMOVAL_BUSY_MESSAGE =
  "another sync of this repository is running; removal retried on the next sync";
export const REMOVAL_CHANGED_MESSAGE =
  "repository changed during the run; removal re-checked on the next sync";
export const REMOVAL_ABORTED_MESSAGE = "sync aborted before the repository was removed";

/** A stored repo as the planner needs it. */
export interface StoredRepoRef {
  id: number;
  githubId: number;
  owner: string;
  name: string;
}

export interface PlannedRemoval extends StoredRepoRef {
  reason: RepoRemovalReason;
}

export interface PlanRemovalsInput {
  stored: readonly StoredRepoRef[];
  discovery: DiscoveryResult;
  config: DiscoveryConfig;
}

/**
 * The stored repos to delete, in `stored` order, each with its reason. Empty when the listing was
 * not complete. A stored repo whose GitHub id is in `discovery.repos` is kept. Otherwise:
 * `excluded` / `archived` when the listing skipped it for that reason; `dropped_from_config` when
 * the config has an explicit `repos` list without its name (case-insensitive, as discovery
 * matches); else `not_in_installation` (gone from the listing: removed from the installation,
 * deleted on GitHub, or config-listed but not accessible).
 */
export function planRemovals(input: PlanRemovalsInput): PlannedRemoval[] {
  const { stored, discovery, config } = input;
  if (discovery.complete !== true) return [];
  const discovered = new Set(discovery.repos.map((r) => r.githubId));
  const skipped = new Map(discovery.skipped.map((r) => [r.githubId, r.reason]));
  const wanted =
    config.repos === undefined
      ? null
      : new Set(config.repos.map((e) => (typeof e === "string" ? e : e.name).toLowerCase()));

  const out: PlannedRemoval[] = [];
  for (const row of stored) {
    if (discovered.has(row.githubId)) continue;
    const skipReason = skipped.get(row.githubId);
    let reason: RepoRemovalReason;
    if (skipReason !== undefined) reason = skipReason;
    else if (wanted !== null && !wanted.has(row.name.toLowerCase())) reason = "dropped_from_config";
    else reason = "not_in_installation";
    out.push({ ...row, reason });
  }
  return out;
}

/**
 * Every stored repo, for planning. A write-side read for the sync itself (like persist's), not a
 * portal read, so it does not go through the read-side visibility filter.
 */
export async function readStoredRepos(db: Db): Promise<StoredRepoRef[]> {
  return db
    .select({ id: repos.id, githubId: repos.githubId, owner: repos.owner, name: repos.name })
    .from(repos)
    .orderBy(asc(repos.id));
}

/** The database clock, to stamp when a listing was taken (compared with `updated_at`). */
export async function databaseNow(db: Db): Promise<Date> {
  const result = await db.execute<{ now: Date | string }>(sql`select now() as now`);
  const value = result.rows[0]?.now;
  return value instanceof Date ? value : new Date(String(value));
}

export type RemovalStatus =
  /** Deleted, with its documents and code owners. */
  | "removed"
  /** The repo lock was held by another sync: left alone, re-planned next run. */
  | "busy"
  /** The row no longer matched the plan (re-synced, re-added or already gone): left alone. */
  | "changed"
  /** The run was aborted before this repo. */
  | "aborted"
  /** The lock or the delete failed (database problem). */
  | "error";

export interface RemovalOutcome {
  repo: PlannedRemoval;
  status: RemovalStatus;
  /** Documents deleted with the repo (0 unless `removed`). */
  documentsRemoved: number;
  /** Set when `status` is `error`. */
  error: SyncErrorInfo | null;
}

export interface ExecuteRemovalsOptions {
  /** GitHub ids this run discovered; a row with one of them is never deleted. */
  discoveredGithubIds: readonly number[];
  /** Database time taken just before the listing; rows written after it are left alone. */
  listedAt: Date;
  signal?: AbortSignal;
}

interface DeleteGuard {
  discoveredGithubIds?: readonly number[];
  listedAt?: Date;
}

/**
 * Deletes one row in its own transaction, conditionally, and returns how many documents went with
 * it (null when the condition no longer held and nothing was deleted). Call under the repo lock.
 */
async function deleteRepoRow(
  db: Db,
  repo: StoredRepoRef,
  guard: DeleteGuard,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const conditions: SQL[] = [eq(repos.id, repo.id), eq(repos.githubId, repo.githubId)];
    if (guard.discoveredGithubIds !== undefined && guard.discoveredGithubIds.length > 0) {
      conditions.push(notInArray(repos.githubId, [...guard.discoveredGithubIds]));
    }
    if (guard.listedAt !== undefined) conditions.push(lte(repos.updatedAt, guard.listedAt));
    // Lock the row first so the document count matches what the cascade deletes.
    const [row] = await tx
      .select({ id: repos.id })
      .from(repos)
      .where(and(...conditions))
      .for("update");
    if (row === undefined) return null;
    const [docs] = await tx
      .select({ n: count() })
      .from(documents)
      .where(eq(documents.repoId, row.id));
    await tx.delete(repos).where(eq(repos.id, row.id));
    return docs?.n ?? 0;
  });
}

/**
 * Deletes the planned repos one at a time, each under its repo sync lock in try mode and in its
 * own transaction (see the module comment for the DELETE's guard). Never throws for one repo's
 * failure; returns one outcome per planned repo, in order.
 */
export async function executeRemovals(
  db: Db,
  pool: Pool,
  planned: readonly PlannedRemoval[],
  options: ExecuteRemovalsOptions,
): Promise<RemovalOutcome[]> {
  const outcomes: RemovalOutcome[] = [];
  const guard: DeleteGuard = {
    discoveredGithubIds: options.discoveredGithubIds,
    listedAt: options.listedAt,
  };
  for (const repo of planned) {
    const outcome = (
      status: RemovalStatus,
      documentsRemoved = 0,
      error: SyncErrorInfo | null = null,
    ) => outcomes.push({ repo, status, documentsRemoved, error });
    if (options.signal?.aborted) {
      outcome("aborted");
      continue;
    }
    try {
      const lock = await withRepoSyncLock(
        pool,
        { githubId: repo.githubId },
        () => deleteRepoRow(db, repo, guard),
        { signal: options.signal, waitMs: 0 },
      );
      if (!lock.acquired) outcome(lock.reason === "aborted" ? "aborted" : "busy");
      else if (lock.value === null) outcome("changed");
      else outcome("removed", lock.value);
    } catch (error) {
      outcome("error", 0, describeSyncError(error));
    }
  }
  return outcomes;
}

function skippedEntry(repo: PlannedRemoval, kind: string, message: string): SyncRepoResult {
  const entry = failureEntry(
    repo,
    { kind, message, retryable: true, retryAt: null, fatal: false },
    "skipped",
  );
  entry.removalReason = repo.reason;
  return entry;
}

/**
 * The `sync_runs.results` entry for a removal outcome: `removed` (with the deleted document
 * count), `skipped` for busy/changed/aborted (the next run re-plans it), `error` for a failure.
 * Every entry carries `removalReason`.
 */
export function removalOutcomeEntry(outcome: RemovalOutcome): SyncRepoResult {
  const { repo } = outcome;
  switch (outcome.status) {
    case "removed":
      return removalEntry(repo, repo.reason, outcome.documentsRemoved);
    case "busy":
      return skippedEntry(repo, "busy", REMOVAL_BUSY_MESSAGE);
    case "changed":
      return skippedEntry(repo, "changed", REMOVAL_CHANGED_MESSAGE);
    case "aborted":
      return skippedEntry(repo, "aborted", REMOVAL_ABORTED_MESSAGE);
    case "error": {
      const entry = failureEntry(repo, outcome.error ?? describeSyncError(undefined));
      entry.removalReason = repo.reason;
      return entry;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// removeRepo

export type RemoveRepoTarget = { githubId: number } | { owner: string; name: string };

export interface RemoveRepoOptions {
  /** Passed to `withRepoSyncLock`. Default 0: return `busy` at once. */
  lockWaitMs?: number;
  signal?: AbortSignal;
}

export type RemoveRepoResult =
  | { status: "removed"; repo: StoredRepoRef; reason: RepoRemovalReason; documentsRemoved: number }
  /** No stored row for the target (never synced, or already removed). */
  | { status: "not_found" }
  /** Another sync holds the repo lock (or the wait timed out); nothing was deleted. */
  | { status: "busy" }
  | { status: "aborted" };

/**
 * Deletes one stored repo (cascading to its documents and code owners) under its repo sync lock,
 * with confirmed-gone semantics: no listing check, no freshness guard.
 *
 * For task 6.3: call it ONLY on an authoritative signal, a verified webhook event such as
 * `repository` deleted (`deleted`) or archived (`archived`), or `installation_repositories`
 * removed (`not_in_installation`). NEVER call it on a 404 from a fetch, a failed listing or
 * `syncOne`'s `not_found`: those can be transient and must keep stored content.
 *
 * A name target is matched case-insensitively (as GitHub does); a GitHub id target exactly. It
 * records no run; the caller adds `removalEntry` to its run ledger if it has one.
 */
export async function removeRepo(
  db: Db,
  pool: Pool,
  target: RemoveRepoTarget,
  reason: RepoRemovalReason,
  options: RemoveRepoOptions = {},
): Promise<RemoveRepoResult> {
  const where =
    "githubId" in target
      ? (() => {
          if (!Number.isSafeInteger(target.githubId) || target.githubId < 1) {
            throw new TypeError("githubId must be a positive integer");
          }
          return eq(repos.githubId, target.githubId);
        })()
      : (() => {
          if (
            typeof target.owner !== "string" ||
            typeof target.name !== "string" ||
            target.owner === "" ||
            target.name === ""
          ) {
            throw new TypeError("owner and name must be non-empty strings");
          }
          return sql`lower(${repos.owner}) = lower(${target.owner}) and lower(${repos.name}) = lower(${target.name})`;
        })();
  const [row] = await db
    .select({ id: repos.id, githubId: repos.githubId, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(where)
    .orderBy(asc(repos.id))
    .limit(1);
  if (row === undefined) return { status: "not_found" };

  const lock = await withRepoSyncLock(
    pool,
    { githubId: row.githubId },
    () => deleteRepoRow(db, row, {}),
    { signal: options.signal, waitMs: options.lockWaitMs ?? 0 },
  );
  if (!lock.acquired) return { status: lock.reason === "aborted" ? "aborted" : "busy" };
  if (lock.value === null) return { status: "not_found" };
  return { status: "removed", repo: row, reason, documentsRemoved: lock.value };
}
