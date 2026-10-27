import { and, eq, lt, sql } from "drizzle-orm";
import type { DomainEventInput, SyncTrigger } from "@docmyrepos/core";
import type { Pool } from "pg";

import {
  AdvisoryLockError,
  advisoryLockKey,
  withAdvisoryLock,
  withRepoSyncLock,
} from "../db/advisory-lock";
import type { Db } from "../db/client";
import {
  repos,
  syncRuns,
  type RepoRemovalReason,
  type SyncRepoResult,
  type SyncWarning,
} from "../db/schema";
import { GitHubError, isValidOwner, isValidRepoName, type GitHubErrorKind } from "../github/client";
import { errorFields, logger, type LogFields, type Logger } from "../log";
import { NOT_ACCESSIBLE_MESSAGE } from "./discovery";
import { toDbText } from "./document-record";
import { PersistError, mapVisibility, type PersistResult } from "./persist";
import { visibilityWrite, type DbInstant } from "./requests";

/**
 * Sync runs and per-repository status (task 5.7).
 *
 * - `withRun` wraps one sync run (one repo or all): it inserts a `running` row in `sync_runs`,
 *   holds the run lock (`advisoryLockKey('docmyrepos:sync-run', id)`) for the whole run, re-reads
 *   its row after locking (a reaper may have failed it already), runs the body, and writes the
 *   final status, counters and per-repo results in `finally`, only `where status = 'running'`.
 * - `runRepos` runs a per-repo worker inside each repo's sync lock and isolates failures: an error
 *   in one repo is recorded on that repo and the loop goes on. Only installation- or run-wide
 *   errors (`FATAL_GITHUB_KINDS`, aborts) stop the run; the repos not yet attempted are reported as
 *   `skipped` and their stored content is not touched.
 * - `recordRepoOutcome` writes `repos.sync_status` / `sync_error` / `last_synced_at`. A failure
 *   never touches documents, README, code owners or the head state; it only flags the row. A repo
 *   that has no row yet (first sync failed) is not created: per the design its failure lives only
 *   in `sync_runs.results`.
 * - `reapStaleRuns` fails `running` rows whose process died: older than a grace period AND whose
 *   run lock can be taken. A live run holds its lock, so it is never reaped.
 *
 * Every message stored or returned here is a fixed text chosen by error kind (`describeSyncError`).
 * Raw error messages, GitHub bodies, SQL text and tokens are never stored.
 *
 * Logging (task 12.4, structured, `../log`): `withRun` writes `sync.run.started`, one line per
 * repository outcome when the run ends (`sync.repo.done`, `sync.repo.removed`; unchanged repos at
 * `debug`), then `sync.run.finished` with the status, duration and counters; `sync.run.not_run`
 * when it could not start; `sync.run.error` (safe error fields only) when the body threw.
 * `reapStaleRuns` writes `sync.run.reaped`. Lines carry ids, counts and kinds; a repository's
 * `owner/name` only when both parts pass the GitHub name rules.
 */

export const SYNC_RUN_LOCK_NAMESPACE = "docmyrepos:sync-run";
/** Covers only the gap between inserting a run row and taking its run lock. */
export const DEFAULT_STALE_GRACE_MS = 60_000;
/** Most per-repo entries kept in `sync_runs.results`; the counters always count every repo. */
export const MAX_RESULT_REPOS = 500;
/** Most items kept per list (warnings, skipped files, failed files) in one repo's entry. */
export const MAX_RESULT_LIST = 50;
/** Longest string kept in results (paths, messages). */
export const MAX_RESULT_TEXT = 500;
/**
 * JSON budget for the per-file lists in `sync_runs.results`. Entries past it keep only their
 * status, error and counts, so the whole column stays near this size plus ~500 bytes per repo.
 */
export const MAX_RESULTS_BYTES = 1024 * 1024;

export const REAPED_RUN_ERROR = "sync run abandoned: the process stopped before it finished";
export const RUN_LOCK_ERROR = "sync run could not take its run lock (database connection problem)";
export const RUN_ABORTED_ERROR = "sync aborted";
export const REPO_BUSY_MESSAGE = "another sync of this repository is running";
/** A pass skipped because a newer sync wrote the repository after this pass's listing (task 6.4). */
export const SUPERSEDED_MESSAGE =
  "skipped: a newer sync of this repository finished after this run listed it";
/** A pass skipped because the repository was removed (webhook) after this pass's listing. */
export const REMOVED_SINCE_LISTING_MESSAGE =
  "skipped: the repository was removed after this run listed it";
export const LOCK_LOST_MESSAGE =
  "lost the repository sync lock (database connection problem); retried on the next sync";

export type RunTrigger = (typeof syncRuns.$inferInsert)["trigger"];
export type RunStatus = "success" | "partial" | "failed";

export function syncRunLockKey(runId: number): string {
  return advisoryLockKey(SYNC_RUN_LOCK_NAMESPACE, String(runId));
}

// ---------------------------------------------------------------------------------------------
// Errors

export type RepoSyncErrorKind =
  /** The recursive tree was truncated by GitHub (task 5.4). */
  | "tree_truncated"
  /** Listed in config but not accessible to the installation (task 5.3). */
  | "not_accessible";

/**
 * Thrown by a worker that decides not to sync a repo at all because its listing is stale for it:
 * `superseded` (task 6.4: a newer sync or a `privatized` webhook wrote the row after the listing)
 * or `removed` (a webhook removed the row after the listing; recreating it from the listing
 * would resurrect it). `runRepos` reports the repo `skipped` and records no status.
 */
export class RepoSyncSkipped extends Error {
  override name = "RepoSyncSkipped";
  readonly kind: "superseded" | "removed";
  constructor(kind: "superseded" | "removed" = "superseded") {
    super(kind === "removed" ? REMOVED_SINCE_LISTING_MESSAGE : SUPERSEDED_MESSAGE);
    this.kind = kind;
  }
}

/**
 * A typed per-repo failure the worker can throw for outcomes that are not exceptions upstream.
 * (More docs than the per-repo cap is not a failure since task 12.3: the selection is capped and
 * the repo warned, see `tree.ts`.)
 */
export class RepoSyncError extends Error {
  override name = "RepoSyncError";
  readonly kind: RepoSyncErrorKind;
  constructor(kind: RepoSyncErrorKind) {
    super(`repo sync failed: ${kind}`);
    this.kind = kind;
  }
}

/**
 * GitHub error kinds that stop the whole run: they come from the installation or the App
 * credentials (every other repo would fail the same way), from the rate limit (continuing only
 * burns requests until the reset; the client already waited up to its `maxWaitMs`), or from an
 * abort. Every other kind (`not_found`, `forbidden`, `server`, `network`, `client_error`,
 * `invalid_response`, `invalid_input`) is recorded on its repo and the run goes on. `forbidden` is
 * per-repo here (a 403 without rate-limit headers is about one repository's access), although
 * `syncBlobs` stops that repo's own fetch on it.
 */
export const FATAL_GITHUB_KINDS: ReadonlySet<GitHubErrorKind> = new Set<GitHubErrorKind>([
  "rate_limited",
  "unauthorized",
  "app_credentials",
  "invalid_private_key",
  "installation_unavailable",
  "aborted",
]);

/**
 * Fatal kinds that are about the installation as a whole: every repo the run had not reached yet
 * is also marked `error` with the same message (content kept), so the portal shows the outage on
 * each repo. Rate limits and aborts leave the unreached repos' status as it was.
 */
export const INSTALLATION_WIDE_KINDS: ReadonlySet<string> = new Set<string>([
  "unauthorized",
  "app_credentials",
  "invalid_private_key",
  "installation_unavailable",
]);

/** A safe, fixed description of a sync failure. */
export interface SyncErrorInfo {
  kind: string;
  message: string;
  retryable: boolean;
  /** Epoch ms after which a rate-limited request can be retried, when known. */
  retryAt: number | null;
  /** True when the error stops the whole run. */
  fatal: boolean;
}

const GITHUB_MESSAGES: Record<GitHubErrorKind, string> = {
  rate_limited: "GitHub rate limit exhausted",
  not_found: "not found on GitHub (deleted, renamed, or not accessible by the GitHub App)",
  forbidden: "GitHub denied access to this repository (check the GitHub App's permissions)",
  unauthorized: "GitHub rejected the installation token",
  server: "GitHub server error; retried on the next sync",
  network: "network error while contacting GitHub; retried on the next sync",
  aborted: RUN_ABORTED_ERROR,
  client_error: "GitHub rejected a request",
  invalid_response: "unexpected response from GitHub",
  invalid_input: "invalid repository name, ref or path",
  too_large: "a file was larger than the allowed size",
  installation_unavailable: "GitHub App installation unavailable",
  app_credentials: "GitHub App credentials rejected (check the App id and private key)",
  invalid_private_key: "GitHub App private key is not a valid PEM RSA private key",
};

const RETRYABLE_GITHUB: ReadonlySet<GitHubErrorKind> = new Set<GitHubErrorKind>([
  "rate_limited",
  "server",
  "network",
  "aborted",
  "installation_unavailable",
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Maps any thrown value to a fixed message by kind. Never copies `error.message`: every text is a
 * constant plus validated numbers or a SQLSTATE, so tokens, GitHub bodies and SQL cannot leak.
 */
export function describeSyncError(error: unknown, now: number = Date.now()): SyncErrorInfo {
  if (error instanceof GitHubError) {
    const kind = error.kind;
    let message = GITHUB_MESSAGES[kind] ?? "GitHub request failed";
    let retryAt: number | null = null;
    if (kind === "rate_limited") {
      const after = error.retryAfterMs;
      if (typeof after === "number" && Number.isFinite(after) && after >= 0) {
        retryAt = now + after;
        message += `; retry after ${new Date(Math.ceil(retryAt / 1000) * 1000).toISOString()}`;
      } else {
        message += "; retry later";
      }
    }
    return {
      kind,
      message,
      retryable: RETRYABLE_GITHUB.has(kind),
      retryAt,
      fatal: FATAL_GITHUB_KINDS.has(kind),
    };
  }
  if (error instanceof PersistError) {
    switch (error.kind) {
      case "aborted":
        return info("aborted", RUN_ABORTED_ERROR, true, true);
      case "stale_plan":
        return info(
          "stale_plan",
          "stored state changed during the sync; retried on the next sync",
          true,
        );
      case "name_conflict_busy":
        return info(
          "name_conflict_busy",
          "another repository with this name is being synced; retried on the next sync",
          true,
        );
      case "database": {
        const code =
          typeof error.code === "string" && SQLSTATE.test(error.code) ? error.code : null;
        return info(
          "database",
          `database error while saving the repository${code ? ` (SQLSTATE ${code})` : ""}`,
          true,
        );
      }
    }
  }
  if (error instanceof RepoSyncError) {
    switch (error.kind) {
      case "tree_truncated":
        return info(
          "tree_truncated",
          "repository tree truncated by GitHub (too large to list in one call); docs not synced",
          false,
        );
      case "not_accessible":
        return info("not_accessible", NOT_ACCESSIBLE_MESSAGE, false);
    }
  }
  if (error instanceof AdvisoryLockError) {
    return info(
      "lock",
      "could not take the repository sync lock (database connection problem)",
      true,
    );
  }
  return info("unexpected", "unexpected error during sync", true);
}

function info(kind: string, message: string, retryable: boolean, fatal = false): SyncErrorInfo {
  return { kind, message, retryable, retryAt: null, fatal };
}

// ---------------------------------------------------------------------------------------------
// Per-repo status

export interface RepoIdentity {
  githubId: number;
}

export type RepoStatusOutcome =
  | { status: "ok" }
  | {
      status: "error";
      /** A fixed message, normally `describeSyncError(...).message`. */
      message: string;
      /**
       * GitHub's visibility for the repo, when known (from the listing). Written with the error so
       * a failed sync still applies a visibility change; mapped like persist (fail closed).
       * `private` is always written. `public` is written only with `listedAt`, and then never over
       * a `private` stored after that instant (`visibilityWrite`: the row stays private and its
       * rerun marker is set); without `listedAt` a `public` is not written at all (fail closed).
       */
      visibility?: string;
      /** The database instant taken before the listing `visibility` came from. */
      listedAt?: DbInstant;
    };

/** The visibility columns an error outcome writes (see `RepoStatusOutcome`). */
function errorVisibility(visibility: string | undefined, listedAt: DbInstant | undefined) {
  if (visibility === undefined) return {};
  const mapped = mapVisibility(visibility);
  if (mapped === "private") return { visibility: mapped };
  return listedAt === undefined ? {} : visibilityWrite(mapped, listedAt);
}

/**
 * Records a repo's sync status on its existing row (matched by `github_id`). Success: `ok`, no
 * error, `last_synced_at = now()`. Failure: `error` with the message (and visibility, if given);
 * nothing else changes, so all stored content is kept. Returns false when the repo has no row (a
 * first sync that failed): nothing is created, the failure lives in `sync_runs.results` only.
 * Call it while holding the repo's sync lock.
 */
export async function recordRepoOutcome(
  db: Db,
  repo: RepoIdentity,
  outcome: RepoStatusOutcome,
): Promise<boolean> {
  if (!Number.isSafeInteger(repo.githubId) || repo.githubId <= 0) {
    throw new TypeError("repo.githubId must be a positive integer");
  }
  const set =
    outcome.status === "ok"
      ? { syncStatus: "ok" as const, syncError: null, lastSyncedAt: sql`now()` }
      : {
          syncStatus: "error" as const,
          syncError: clip(outcome.message),
          ...errorVisibility(outcome.visibility, outcome.listedAt),
        };
  const rows = await db
    .update(repos)
    .set(set)
    .where(eq(repos.githubId, repo.githubId))
    .returning({ id: repos.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Results

/** What a worker returns for a repo it synced (it throws for a failure). */
export interface RepoWorkResult {
  persist: PersistResult;
  /** True when the plan was `unchanged` (tree short-circuit). */
  unchanged: boolean;
  /** Files the tree selection skipped (task 5.4), reported with the run. */
  selectionSkipped?: readonly { path: string; reason: string }[];
  /** Extra warnings from earlier stages. */
  warnings?: readonly SyncWarning[];
}

export interface RunRepo extends RepoIdentity {
  owner: string;
  name: string;
  /** GitHub's visibility from the listing, recorded on failure too. */
  visibility?: string;
}

function clip(text: string, max = MAX_RESULT_TEXT): string {
  const clean = toDbText(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function emptyEntry(repo: RunRepo, status: SyncRepoResult["status"]): SyncRepoResult {
  return {
    repo: clip(`${repo.owner}/${repo.name}`),
    githubId: repo.githubId,
    status,
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
  };
}

const INCOMPLETE_KIND = "incomplete";

function incompleteMessage(n: number): string {
  return `${n} file${n === 1 ? "" : "s"} could not be fetched from GitHub; stored versions kept, retried on the next sync`;
}

/** A results entry for a repo whose worker returned. Incomplete syncs are entries with an error. */
export function successEntry(repo: RunRepo, work: RepoWorkResult): SyncRepoResult {
  const p = work.persist;
  const complete = p.complete;
  const entry = emptyEntry(repo, complete ? (work.unchanged ? "unchanged" : "ok") : "error");
  if (!complete) {
    entry.error = incompleteMessage(p.failed.length);
    entry.errorKind = INCOMPLETE_KIND;
    entry.retryable = true;
  }
  const skippedFiles = [
    ...p.skipped.map((s) => ({ path: s.path, reason: s.reason as string })),
    ...(work.selectionSkipped ?? []),
  ];
  const warnings = [...(work.warnings ?? []), ...p.warnings];
  entry.added = p.added;
  entry.updated = p.updated;
  entry.identical = p.identical;
  entry.removed = p.removed;
  entry.skipped = skippedFiles.length;
  entry.skippedFiles = skippedFiles
    .slice(0, MAX_RESULT_LIST)
    .map((s) => ({ path: clip(s.path), reason: clip(s.reason, 64) }));
  entry.failedFiles = p.failed.slice(0, MAX_RESULT_LIST).map((f) => clip(f));
  entry.failedFilesTotal = p.failed.length;
  entry.warnings = warnings.slice(0, MAX_RESULT_LIST).map((w) => ({
    path: w.path === null ? null : clip(w.path),
    message: clip(w.message),
  }));
  entry.warningsTotal = warnings.length;
  entry.replacedRepos = p.replacedRepos
    .slice(0, MAX_RESULT_LIST)
    .map((r) => clip(`${r.owner}/${r.name}`));
  return entry;
}

/**
 * A results entry for a repo the removal step deleted (task 5.9): status `removed`, the reason,
 * and the number of documents deleted with it in `removed`.
 */
export function removalEntry(
  repo: RunRepo,
  reason: RepoRemovalReason,
  documentsRemoved: number,
): SyncRepoResult {
  const entry = emptyEntry(repo, "removed");
  entry.removalReason = reason;
  entry.removed = documentsRemoved;
  return entry;
}

/** A results entry for a failed or skipped repo. */
export function failureEntry(
  repo: RunRepo,
  error: SyncErrorInfo,
  status: "error" | "skipped" = "error",
): SyncRepoResult {
  const entry = emptyEntry(repo, status);
  entry.error = clip(error.message);
  entry.errorKind = clip(error.kind, 64);
  entry.retryable = error.retryable;
  entry.retryAfter = error.retryAt === null ? null : new Date(error.retryAt).toISOString();
  return entry;
}

// ---------------------------------------------------------------------------------------------
// runRepos

export interface RunReposOptions {
  /** Stops the loop before the next repo; remaining repos are `skipped` and the run is fatal. */
  signal?: AbortSignal;
  /** Repos worked on at once. Default 1. Each in-flight repo holds one extra pool connection. */
  concurrency?: number;
  /**
   * Record a fatal GitHub error on its repo and keep going instead of stopping. Aborts always stop.
   * For callers that know the error is not installation-wide; off by default.
   */
  continueOnFatal?: boolean;
  /** Passed to `withRepoSyncLock`. Default 0: a busy repo is skipped (the caller marks it, 6.4). */
  lockWaitMs?: number;
  /**
   * The caller already holds the sync lock of the one repo in `items` (task 6.4, `requestSync`):
   * the worker runs under that lock instead of taking it again (locks are not re-entrant, a second
   * acquire would be busy). `signal` is the held lock's signal (aborts when its connection is lost).
   */
  heldLock?: HeldRepoLock;
  /**
   * The database instant taken before the listing `items` came from. Passed with the listed
   * visibility to `recordRepoOutcome` on the error path; without it a failed repo's `public` is
   * not written (only `private` is).
   */
  listedAt?: DbInstant;
  /** Clock for rate-limit retry times. */
  now?: () => number;
}

/** A repo sync lock the caller holds: the repo's GitHub id and the lock's signal. */
export interface HeldRepoLock {
  readonly githubId: number;
  readonly signal: AbortSignal;
}

/**
 * Runs `fn` under the repo's sync lock: directly when `held` is that repo's lock, else through
 * `withRepoSyncLock` in try mode (a busy lock skips `fn`). For short status writes.
 */
export async function underRepoLock(
  pool: Pool,
  githubId: number,
  held: HeldRepoLock | undefined,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (held !== undefined && held.githubId === githubId) {
    await fn();
    return;
  }
  await withRepoSyncLock(pool, { githubId }, fn);
}

export interface RunReposResult {
  /** One entry per item, in input order. */
  results: SyncRepoResult[];
  /** The error that stopped the run, or null. */
  fatal: SyncErrorInfo | null;
}

export type RepoWorker<T extends RunRepo> = (
  repo: T,
  context: { signal: AbortSignal },
) => Promise<RepoWorkResult>;

/**
 * Runs `worker` for each repo inside that repo's sync lock (keyed on `githubId`) and records the
 * repo's status while still holding the lock. A failure in one repo (any thrown value, including a
 * non-fatal `GitHubError`, a `PersistError` or a `RepoSyncError`) is recorded on that repo
 * (`sync_status = error`, safe message, content kept) and the next repo runs. A fatal error (see
 * `FATAL_GITHUB_KINDS`, `PersistError('aborted')`, or `signal` aborting) stops the loop: in-flight
 * repos are aborted and every repo not finished is reported `skipped` with the fatal message, and
 * for installation-wide kinds also marked `error` on its row. A repo whose lock is busy is
 * `skipped` (not an error). Never throws for a per-repo failure; `results` is in input order.
 */
export async function runRepos<T extends RunRepo>(
  db: Db,
  pool: Pool,
  items: readonly T[],
  worker: RepoWorker<T>,
  options: RunReposOptions = {},
): Promise<RunReposResult> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const held = options.heldLock;
  if (held !== undefined && items.some((item) => item.githubId !== held.githubId)) {
    throw new TypeError("heldLock covers only the repo it was taken for");
  }
  const results: (SyncRepoResult | undefined)[] = new Array(items.length);
  let fatal: SyncErrorInfo | null = null;
  // Aborted on a fatal error so in-flight repos stop early.
  const stop = new AbortController();
  const runSignal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;

  const setFatal = (error: SyncErrorInfo) => {
    if (fatal === null) fatal = error;
    stop.abort();
  };
  const abortedInfo = (): SyncErrorInfo => info("aborted", RUN_ABORTED_ERROR, true, true);

  const runOne = async (index: number, repo: T): Promise<void> => {
    let entry: SyncRepoResult | undefined;
    let lock;
    const locked = async ({ signal }: { signal: AbortSignal }): Promise<void> => {
      let outcome: SyncRepoResult;
      let status: RepoStatusOutcome;
      try {
        const work = await worker(repo, { signal });
        outcome = successEntry(repo, work);
        status =
          outcome.status === "error"
            ? {
                status: "error",
                message: outcome.error ?? "",
                visibility: repo.visibility,
                listedAt: options.listedAt,
              }
            : { status: "ok" };
      } catch (error) {
        if (error instanceof RepoSyncSkipped) {
          entry = failureEntry(repo, info(error.kind, error.message, false), "skipped");
          return;
        }
        let described = describeSyncError(error, now());
        if (described.kind === "aborted" && signal.aborted && !runSignal.aborted) {
          // Only this repo's lock connection was lost: a per-repo failure, not a run abort.
          described = info("lock_lost", LOCK_LOST_MESSAGE, true);
        }
        if (described.fatal && fatal !== null && described.kind === "aborted") {
          // Stopped because another repo hit a fatal error: not this repo's failure.
          entry = failureEntry(repo, fatal, "skipped");
          return;
        }
        if (described.fatal && (described.kind === "aborted" || !options.continueOnFatal)) {
          setFatal(described);
        }
        if (described.kind === "aborted") {
          entry = failureEntry(repo, described, "skipped");
          return;
        }
        outcome = failureEntry(repo, described);
        status = {
          status: "error",
          message: described.message,
          visibility: repo.visibility,
          listedAt: options.listedAt,
        };
      }
      entry = outcome;
      // A lost lock means another sync may own the repo now: do not write its status.
      if (signal.aborted && !runSignal.aborted) return;
      try {
        await recordRepoOutcome(db, repo, status);
      } catch {
        // The entry still reports the outcome; the next sync records the status.
      }
    };
    try {
      if (held !== undefined) {
        await locked({ signal: AbortSignal.any([held.signal, runSignal]) });
        lock = { acquired: true as const, value: undefined };
      } else {
        lock = await withRepoSyncLock(pool, { githubId: repo.githubId }, locked, {
          signal: runSignal,
          waitMs: options.lockWaitMs ?? 0,
        });
      }
    } catch (error) {
      entry = failureEntry(repo, describeSyncError(error, now()));
    }
    if (entry === undefined && lock !== undefined && !lock.acquired) {
      entry =
        lock.reason === "aborted"
          ? failureEntry(repo, fatal ?? abortedInfo(), "skipped")
          : failureEntry(repo, info("busy", REPO_BUSY_MESSAGE, true), "skipped");
      if (lock.reason === "aborted") setFatal(fatal ?? abortedInfo());
    }
    results[index] = entry;
  };

  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      if (runSignal.aborted) {
        setFatal(fatal ?? abortedInfo());
        return;
      }
      const index = next++;
      await runOne(index, items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));

  const stoppedBy = fatal as SyncErrorInfo | null;
  for (let i = 0; i < items.length; i++) {
    if (results[i] !== undefined) continue;
    const repo = items[i] as T;
    const reason = stoppedBy ?? abortedInfo();
    results[i] = failureEntry(repo, reason, "skipped");
    if (INSTALLATION_WIDE_KINDS.has(reason.kind)) {
      // Same outage for every repo: flag the row (content kept), under its lock.
      try {
        await underRepoLock(pool, repo.githubId, held, () =>
          recordRepoOutcome(db, repo, {
            status: "error",
            message: reason.message,
            visibility: repo.visibility,
            listedAt: options.listedAt,
          }),
        );
      } catch {
        // Best effort; the run results still say why.
      }
    }
  }
  return { results: results as SyncRepoResult[], fatal: stoppedBy };
}

// ---------------------------------------------------------------------------------------------
// Run rows

export interface RunStats {
  /** Repos the run synced or tried to sync; removal entries are not counted (see `reposRemoved`). */
  reposTotal: number;
  /** Repos synced with changes or unchanged. */
  reposOk: number;
  reposSynced: number;
  reposUnchanged: number;
  reposFailed: number;
  reposSkipped: number;
  /** Repos deleted by the removal step (task 5.9). Stored in `results` only, no column. */
  reposRemoved: number;
  docsAdded: number;
  docsUpdated: number;
  docsRemoved: number;
  docsIdentical: number;
  docsSkipped: number;
  warnings: number;
}

/** Aggregates per-repo entries. Pure. */
export function aggregateRunStats(results: readonly SyncRepoResult[]): RunStats {
  const s: RunStats = {
    reposTotal: 0,
    reposOk: 0,
    reposSynced: 0,
    reposUnchanged: 0,
    reposFailed: 0,
    reposSkipped: 0,
    reposRemoved: 0,
    docsAdded: 0,
    docsUpdated: 0,
    docsRemoved: 0,
    docsIdentical: 0,
    docsSkipped: 0,
    warnings: 0,
  };
  for (const r of results) {
    // A removed repo is not a synced one (not in reposTotal); its deleted documents count in
    // docsRemoved.
    if (r.status !== "removed") s.reposTotal++;
    switch (r.status) {
      case "ok":
        s.reposSynced++;
        break;
      case "unchanged":
        s.reposUnchanged++;
        break;
      case "error":
        s.reposFailed++;
        break;
      case "removed":
        s.reposRemoved++;
        break;
      default:
        s.reposSkipped++;
    }
    s.docsAdded += r.added;
    s.docsUpdated += r.updated;
    s.docsRemoved += r.removed;
    s.docsIdentical += r.identical;
    s.docsSkipped += r.skipped;
    s.warnings += r.warningsTotal;
  }
  s.reposOk = s.reposSynced + s.reposUnchanged;
  return s;
}

/**
 * Final status. A fatal error: `failed`. Otherwise no failed repo: `success` (busy-skipped repos
 * are someone else's sync, and zero repos is a successful run); some failed with at least one ok:
 * `partial`; failures and nothing ok: `failed`.
 */
export function computeRunStatus(stats: RunStats, fatal: SyncErrorInfo | null): RunStatus {
  if (fatal !== null) return "failed";
  if (stats.reposFailed === 0) return "success";
  return stats.reposOk > 0 ? "partial" : "failed";
}

export interface StartRunInput {
  trigger: RunTrigger;
  /** "owner/name" for a single-repo run, null for a full run. */
  scope: string | null;
}

/** Inserts a `running` row and returns its id. `withRun` is the normal entry point. */
export async function startRun(db: Db, input: StartRunInput): Promise<number> {
  const [row] = await db
    .insert(syncRuns)
    .values({ trigger: input.trigger, scope: input.scope === null ? null : clip(input.scope) })
    .returning({ id: syncRuns.id });
  return (row as { id: number }).id;
}

export interface FinishRunInput {
  results: readonly SyncRepoResult[];
  /** The error that stopped the run (or the body's exception), or null. */
  fatal: SyncErrorInfo | null;
}

export interface FinishRunResult {
  /** False when the row was no longer `running` (reaped): nothing was written. */
  written: boolean;
  status: RunStatus;
  stats: RunStats;
  /** finished_at - started_at in ms, when written. */
  durationMs: number | null;
}

/**
 * The results stored for a run: at most `MAX_RESULT_REPOS` entries and about
 * `MAX_RESULTS_BYTES` of JSON. Once the budget is reached, later entries keep their status,
 * error and counts but drop their lists (the `*Total` fields and `skipped` still count them);
 * entries past the repo cap are dropped (the run counters still count them). Pure.
 */
export function boundResults(results: readonly SyncRepoResult[]): SyncRepoResult[] {
  const out: SyncRepoResult[] = [];
  let bytes = 2;
  for (const entry of results.slice(0, MAX_RESULT_REPOS)) {
    let kept = entry;
    let size = JSON.stringify(kept).length + 1;
    if (bytes + size > MAX_RESULTS_BYTES) {
      kept = { ...entry, skippedFiles: [], failedFiles: [], warnings: [], replacedRepos: [] };
      size = JSON.stringify(kept).length + 1;
    }
    bytes += size;
    out.push(kept);
  }
  return out;
}

/**
 * Writes the final status, `finished_at`, counters, results (`boundResults`; the counters count
 * every repo) and the fatal error message, only `where status = 'running'`, so a run
 * that was reaped is never overwritten. Repos skipped = total - synced - unchanged - failed (removal
 * entries are not in total; they are in `results` with status `removed`), and
 * duration = finished_at - started_at; they have no columns of their own.
 */
export async function finishRun(
  db: Db,
  runId: number,
  input: FinishRunInput,
): Promise<FinishRunResult> {
  const stats = aggregateRunStats(input.results);
  const status = computeRunStatus(stats, input.fatal);
  const rows = await db
    .update(syncRuns)
    .set({
      status,
      finishedAt: sql`now()`,
      reposTotal: stats.reposTotal,
      reposSynced: stats.reposSynced,
      reposUnchanged: stats.reposUnchanged,
      reposFailed: stats.reposFailed,
      docsAdded: stats.docsAdded,
      docsUpdated: stats.docsUpdated,
      docsRemoved: stats.docsRemoved,
      docsSkipped: stats.docsSkipped,
      results: boundResults(input.results),
      error: input.fatal === null ? null : clip(input.fatal.message),
    })
    .where(and(eq(syncRuns.id, runId), eq(syncRuns.status, "running")))
    .returning({
      durationMs: sql<string>`(extract(epoch from (${syncRuns.finishedAt} - ${syncRuns.startedAt})) * 1000)::bigint`,
    });
  const row = rows[0];
  return {
    written: row !== undefined,
    status,
    stats,
    durationMs: row === undefined ? null : Number(row.durationMs),
  };
}

/** Marks a run `failed` with a fixed error, only while it is still `running`. */
async function failRun(db: Db, runId: number, error: string): Promise<boolean> {
  const rows = await db
    .update(syncRuns)
    .set({ status: "failed", finishedAt: sql`now()`, error })
    .where(and(eq(syncRuns.id, runId), eq(syncRuns.status, "running")))
    .returning({ id: syncRuns.id });
  return rows.length > 0;
}

/** Collects per-repo entries during a run; `withRun` writes them when the run ends. */
export class RunLedger {
  readonly results: SyncRepoResult[] = [];
  fatal: SyncErrorInfo | null = null;
  add(result: RunReposResult): void {
    this.results.push(...result.results);
    if (result.fatal !== null && this.fatal === null) this.fatal = result.fatal;
  }
}

export interface RunContext {
  readonly runId: number;
  /** Aborts on the caller's abort or when the run lock's connection is lost. Check it often. */
  readonly signal: AbortSignal;
  readonly ledger: RunLedger;
}

export interface WithRunOptions extends StartRunInput {
  signal?: AbortSignal;
  /** Default: the process logger. */
  log?: Logger;
  /** Receives the domain events of the run (`sync.completed`, `sync.failed`). */
  emit?: (event: DomainEventInput) => void;
}

/**
 * The domain event of one repository's result: `sync.completed` with document counts, or
 * `sync.failed` with a fixed failure kind. Skipped repositories emit nothing.
 */
export function syncEventOf(result: SyncRepoResult, trigger: SyncTrigger): DomainEventInput | null {
  if (result.status === "ok" || result.status === "unchanged" || result.status === "removed") {
    return {
      name: "sync.completed",
      payload: {
        githubRepoId: result.githubId,
        trigger,
        added: result.added,
        changed: result.updated,
        removed: result.removed,
      },
    };
  }
  if (result.status === "error") {
    return {
      name: "sync.failed",
      payload: { githubRepoId: result.githubId, trigger, reason: result.errorKind ?? "unknown" },
    };
  }
  return null;
}

/** `owner/name` when both parts are valid GitHub names, else undefined (never logged raw). */
export function loggableRepoName(full: string): string | undefined {
  const slash = full.indexOf("/");
  if (slash < 0) return undefined;
  const owner = full.slice(0, slash);
  const name = full.slice(slash + 1);
  return isValidOwner(owner) && isValidRepoName(name) ? `${owner}/${name}` : undefined;
}

/** The log line for one results entry (task 12.4). */
function logRepoOutcome(log: Logger, entry: SyncRepoResult): void {
  const base: LogFields = { githubId: entry.githubId, repo: loggableRepoName(entry.repo) };
  if (entry.status === "removed") {
    log.info("sync.repo.removed", {
      ...base,
      reason: entry.removalReason ?? null,
      docsRemoved: entry.removed,
      errorKind: entry.errorKind ?? undefined,
    });
    return;
  }
  const fields: LogFields = {
    ...base,
    status: entry.status,
    added: entry.added,
    updated: entry.updated,
    removed: entry.removed,
    identical: entry.identical,
    skipped: entry.skipped,
    failedFiles: entry.failedFilesTotal,
    warnings: entry.warningsTotal,
    ...(entry.errorKind === null
      ? {}
      : { errorKind: entry.errorKind, retryable: entry.retryable, retryAfter: entry.retryAfter }),
  };
  if (entry.status === "unchanged") log.debug("sync.repo.done", fields);
  else if (entry.status === "error") log.warn("sync.repo.done", fields);
  else log.info("sync.repo.done", fields);
}

function logRunFinished(
  log: Logger,
  trigger: RunTrigger,
  scopeKind: string,
  results: readonly SyncRepoResult[],
  fatal: SyncErrorInfo | null,
  finished: FinishRunResult,
): void {
  for (const entry of results) logRepoOutcome(log, entry);
  const s = finished.stats;
  const fields: LogFields = {
    trigger,
    scopeKind,
    status: finished.status,
    written: finished.written,
    durationMs: finished.durationMs,
    repos: s.reposTotal,
    reposOk: s.reposOk,
    reposSynced: s.reposSynced,
    reposUnchanged: s.reposUnchanged,
    reposFailed: s.reposFailed,
    reposSkipped: s.reposSkipped,
    reposRemoved: s.reposRemoved,
    docsAdded: s.docsAdded,
    docsUpdated: s.docsUpdated,
    docsRemoved: s.docsRemoved,
    docsSkipped: s.docsSkipped,
    warnings: s.warnings,
    ...(fatal === null ? {} : { fatalKind: fatal.kind, retryable: fatal.retryable }),
  };
  if (finished.status === "success") log.info("sync.run.finished", fields);
  else log.warn("sync.run.finished", fields);
}

export type WithRunResult<T> =
  | ({ ran: true; runId: number; value: T } & FinishRunResult)
  | {
      ran: false;
      runId: number;
      /** `lock_failed`: the run lock could not be taken; `reaped`: the row was failed by a reaper
       *  before the lock was taken; `aborted`: the signal fired first. */
      reason: "lock_failed" | "reaped" | "aborted";
    };

/**
 * One sync run. Inserts the `running` row, takes the run lock in try mode, re-reads the row (stops
 * if a reaper already failed it), then runs `fn`. `fn` reports repos through `context.ledger`
 * (normally `ledger.add(await runRepos(...))`). In `finally` the final status is written from the
 * ledger, only while the row is still `running`, and then the run lock is released. If `fn`
 * throws, the run is `failed` with a safe message and the error is rethrown. A run uses 2+ pool
 * connections while inside a repo: the run lock, the repo lock, and the queries.
 */
export async function withRun<T>(
  db: Db,
  pool: Pool,
  options: WithRunOptions,
  fn: (context: RunContext) => Promise<T>,
): Promise<WithRunResult<T>> {
  const runId = await startRun(db, options);
  const scopeKind = options.scope === null ? "all" : "repo";
  const log = (options.log ?? logger).child({ runId });
  let lock;
  let state: WithRunResult<T> | undefined;
  let thrown: { error: unknown } | undefined;
  try {
    lock = await withAdvisoryLock(
      pool,
      syncRunLockKey(runId),
      async ({ signal }) => {
        const [row] = await db
          .select({ status: syncRuns.status })
          .from(syncRuns)
          .where(eq(syncRuns.id, runId));
        if (row?.status !== "running") {
          state = { ran: false, runId, reason: "reaped" };
          return;
        }
        const ledger = new RunLedger();
        let value: T | undefined;
        log.info("sync.run.started", { trigger: options.trigger, scopeKind });
        try {
          value = await fn({ runId, signal, ledger });
        } catch (error) {
          thrown = { error };
          log.error("sync.run.error", errorFields(error));
          if (ledger.fatal === null) ledger.fatal = describeSyncError(error);
        } finally {
          if (ledger.fatal === null && signal.aborted)
            ledger.fatal = info("aborted", RUN_ABORTED_ERROR, true, true);
          const finished = await finishRun(db, runId, ledger);
          state = { ran: true, runId, value: value as T, ...finished };
          logRunFinished(log, options.trigger, scopeKind, ledger.results, ledger.fatal, finished);
          if (options.emit) {
            for (const result of ledger.results) {
              const event = syncEventOf(result, options.trigger);
              if (event !== null) options.emit(event);
            }
          }
        }
      },
      { signal: options.signal },
    );
  } catch (error) {
    if (thrown === undefined && !(error instanceof AdvisoryLockError)) throw error;
    if (thrown === undefined) {
      await failRun(db, runId, RUN_LOCK_ERROR).catch(() => false);
      log.warn("sync.run.not_run", { trigger: options.trigger, scopeKind, reason: "lock_failed" });
      return { ran: false, runId, reason: "lock_failed" };
    }
  }
  if (thrown !== undefined) throw thrown.error;
  if (lock !== undefined && !lock.acquired) {
    const aborted = lock.reason === "aborted";
    await failRun(db, runId, aborted ? RUN_ABORTED_ERROR : RUN_LOCK_ERROR).catch(() => false);
    const reason = aborted ? "aborted" : "lock_failed";
    log.warn("sync.run.not_run", { trigger: options.trigger, scopeKind, reason });
    return { ran: false, runId, reason };
  }
  const final = state as WithRunResult<T> | undefined;
  if (final !== undefined && !final.ran) {
    log.warn("sync.run.not_run", { trigger: options.trigger, scopeKind, reason: final.reason });
  }
  return final as WithRunResult<T>;
}

// ---------------------------------------------------------------------------------------------
// Reaper

export interface ReapOptions {
  /** Reference time; default the database's `now()`. */
  now?: Date;
  /** Default 60 s. */
  graceMs?: number;
  /** Default: the process logger. */
  log?: Logger;
}

/**
 * Fails `running` rows left by a dead process. A row qualifies only when its `started_at` is older
 * than the grace period AND a try-acquire on its run lock succeeds (a live run holds it). While
 * holding that lock it is marked `failed` with `REAPED_RUN_ERROR`, conditionally on still being
 * `running`, so a run that finished meanwhile is not overwritten. Safe to call concurrently: a
 * second reaper finds the lock busy or the row already failed. Returns the reaped ids.
 */
export async function reapStaleRuns(
  db: Db,
  pool: Pool,
  options: ReapOptions = {},
): Promise<number[]> {
  const graceMs = options.graceMs ?? DEFAULT_STALE_GRACE_MS;
  if (typeof graceMs !== "number" || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new TypeError("graceMs must be a finite number >= 0");
  }
  const reference =
    options.now === undefined ? sql`now()` : sql`${options.now.toISOString()}::timestamptz`;
  const candidates = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.status, "running"),
        lt(syncRuns.startedAt, sql`${reference} - make_interval(secs => ${graceMs / 1000})`),
      ),
    )
    .orderBy(syncRuns.id);
  const reaped: number[] = [];
  for (const { id } of candidates) {
    const result = await withAdvisoryLock(pool, syncRunLockKey(id), () =>
      failRun(db, id, REAPED_RUN_ERROR),
    );
    if (result.acquired && result.value) {
      reaped.push(id);
      (options.log ?? logger).warn("sync.run.reaped", { runId: id });
    }
  }
  return reaped;
}
