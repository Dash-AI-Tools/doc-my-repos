import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { withRepoSyncLock, type LockResult } from "../db/advisory-lock";
import { redactWhenLogged, type Db } from "../db/client";
import { documents, repos, type SyncRepoResult, type SyncWarning } from "../db/schema";
import { GitHubError, type GitHubClient } from "../github/client";
import { syncBlobs, type FailedBlob, type RepoLevelResult } from "./blobs";
import {
  discoverRepositories,
  type DiscoveredRepo,
  type DiscoveryConfig,
  type DiscoveryResult,
} from "./discovery";
import { PersistError, persistRepoSync, type PersistPlan, type PersistRepo } from "./persist";
import {
  databaseNow,
  executeRemovals,
  planRemovals,
  readStoredRepos,
  removalOutcomeEntry,
  type RemovalOutcome,
} from "./removal";
import {
  clearSyncRequest,
  databaseInstant,
  isSyncRequested,
  listSyncRequests,
  markSyncRequested,
  storedGithubIds,
  storedStateSince,
  type DbInstant,
} from "./requests";
import {
  INSTALLATION_WIDE_KINDS,
  RepoSyncError,
  RepoSyncSkipped,
  describeSyncError,
  failureEntry,
  reapStaleRuns,
  recordRepoOutcome,
  runRepos,
  underRepoLock,
  withRun,
  type HeldRepoLock,
  type RepoWorkResult,
  type RunLedger,
  type RunRepo,
  type RunTrigger,
  type SyncErrorInfo,
  type WithRunResult,
} from "./runs";
import { planTree, type StoredTreeState, type TreePlan } from "./tree";

/**
 * The sync engine (task 5.8): wires discovery (5.3), tree planning (5.4), blob fetching (5.5),
 * persistence (5.6) and run/status recording (5.7) into three entry points.
 *
 * - `syncRepo`: one discovered repository, lock-free. It is the worker `runRepos` calls inside the
 *   repo's sync lock; `syncRepoLocked` is the standalone form that takes the lock itself.
 * - `syncAll`: a full run. Reaps stale runs, opens a run (`scope` null), lists the installation's
 *   repositories narrowed by config, syncs each one, then removes stored repos the complete
 *   listing no longer selects (task 5.9, `removal.ts`): dropped from config, excluded, archived,
 *   or gone from the installation. Nothing is removed when the listing failed.
 * - `syncOne`: one single-repo run (one pass). The repo must be in the installation listing and
 *   pass the config narrowing; otherwise a typed `not_found` or `not_configured` result is
 *   returned and no run is recorded.
 * - `requestSync` (task 6.4): what `POST /api/sync` and webhooks call for one repo. It records a
 *   rerun marker, then runs `syncOne` passes under the repo lock until no request is waiting, or
 *   reports `coalesced` when another sync holds the repo (that holder runs again for it). See
 *   `requests.ts` for the protocol. `drainSyncRequests` runs every waiting request; `syncAll` calls
 *   it at the end.
 *
 * Inputs are injected through a `SyncContext` (database, pool, GitHub client, validated config);
 * nothing here reads the environment or files. `src/server/runtime.ts` builds the context.
 *
 * Failure handling follows the design's removal rule: a failed repo keeps its stored content and
 * is marked `error` with a fixed message; a failed listing deletes nothing; `syncOne` never
 * deletes (its `not_found` may be transient). Installation-wide
 * listing failures also mark every stored repo `error` (content kept); rate limits and aborts
 * leave the rows as they were.
 */

// ---------------------------------------------------------------------------------------------
// Context

/** The validated config the engine needs; the frozen `loadConfig().config` fits as is. */
export interface SyncConfig extends DiscoveryConfig {
  readonly defaults: { readonly docsPaths: readonly string[] };
}

export type SyncGitHubClient = Pick<
  GitHubClient,
  "listInstallationRepositories" | "getBranchHead" | "getTree" | "getBlob"
>;

export interface SyncTuning {
  /** Repositories synced at once in a full run. Default 1. Each one holds extra pool connections. */
  repoConcurrency?: number;
  /** Blob requests in flight per repository. Default 8. */
  blobConcurrency?: number;
  /** How long a run waits for a repo lock held by another sync. Default 0: skip it as busy. */
  lockWaitMs?: number;
}

export interface SyncContext {
  readonly db: Db;
  readonly pool: Pool;
  readonly github: SyncGitHubClient;
  readonly config: SyncConfig;
  readonly tuning: Readonly<Required<SyncTuning>>;
  /** Clock for rate-limit retry times. */
  readonly now: () => number;
}

export interface CreateSyncContextInput {
  db: Db;
  pool: Pool;
  github: SyncGitHubClient;
  config: SyncConfig;
  tuning?: SyncTuning;
  now?: () => number;
}

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Builds a frozen context. Validates the tuning numbers. The context prints as `[redacted]` when
 * logged, since it holds the pool (whose options carry the database URL).
 */
export function createSyncContext(input: CreateSyncContextInput): SyncContext {
  const tuning = input.tuning ?? {};
  const lockWaitMs = tuning.lockWaitMs ?? 0;
  if (typeof lockWaitMs !== "number" || Number.isNaN(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError("lockWaitMs must be a number >= 0");
  }
  if (!Array.isArray(input.config.defaults.docsPaths)) {
    throw new TypeError("config.defaults.docsPaths must be a list");
  }
  return Object.freeze(
    redactWhenLogged({
      db: input.db,
      pool: input.pool,
      github: input.github,
      config: input.config,
      tuning: Object.freeze({
        repoConcurrency: positiveInt(tuning.repoConcurrency ?? 1, "repoConcurrency"),
        blobConcurrency: positiveInt(tuning.blobConcurrency ?? 8, "blobConcurrency"),
        lockWaitMs,
      }),
      now: input.now ?? Date.now,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Stored state

interface StoredRepoState {
  tree: StoredTreeState;
  readmeSha: string | null;
  codeownersSha: string | null;
  /** Stored blob SHA per document path. */
  docs: Map<string, string>;
}

const NO_TREE: StoredTreeState = {
  treeSha: null,
  selectionFingerprint: null,
  headEtag: null,
  commitSha: null,
};

/**
 * What the last sync stored for the repo with this GitHub id; empty for a first sync. A write-side
 * read for the sync itself (like persist's), not a portal read, so it does not go through the
 * read-side visibility filter.
 */
async function readStoredState(db: Db, githubId: number): Promise<StoredRepoState> {
  const [row] = await db
    .select({
      id: repos.id,
      treeSha: repos.treeSha,
      selectionFingerprint: repos.selectionFingerprint,
      headEtag: repos.headEtag,
      commitSha: repos.commitSha,
      readmeSha: repos.readmeSha,
      codeownersSha: repos.codeownersSha,
    })
    .from(repos)
    .where(eq(repos.githubId, githubId));
  if (row === undefined) {
    return { tree: NO_TREE, readmeSha: null, codeownersSha: null, docs: new Map() };
  }
  const docRows = await db
    .select({ path: documents.path, blobSha: documents.blobSha })
    .from(documents)
    .where(eq(documents.repoId, row.id));
  return {
    tree: {
      treeSha: row.treeSha,
      selectionFingerprint: row.selectionFingerprint,
      headEtag: row.headEtag,
      commitSha: row.commitSha,
    },
    readmeSha: row.readmeSha,
    codeownersSha: row.codeownersSha,
    docs: new Map(docRows.map((d) => [d.path, d.blobSha])),
  };
}

// ---------------------------------------------------------------------------------------------
// syncRepo

export interface SyncRepoOptions {
  /** The repo lock's signal (or the caller's). Checked by every GitHub call and database write. */
  signal?: AbortSignal;
  /**
   * The database instant taken before the listing `repo` came from, passed to persist so a
   * `public` from that listing never overwrites a newer `private` (see `PersistOptions.listedAt`).
   */
  listedAt?: DbInstant;
}

/** What `syncRepo` returns: the `runRepos` worker result plus the tree plan's outcome. */
export interface RepoSyncOutcome extends RepoWorkResult {
  outcome: Exclude<TreePlan["outcome"], "failed">;
}

function fetchFailureWarning(path: string, kind: FailedBlob["kind"]): SyncWarning {
  return { path, message: `could not be fetched from GitHub (${kind}); stored version kept` };
}

function repoLevelWarning(result: RepoLevelResult): SyncWarning[] {
  return result.state === "failed" ? [fetchFailureWarning(result.file.path, result.kind)] : [];
}

function persistRepoOf(repo: DiscoveredRepo): PersistRepo {
  return {
    githubId: repo.githubId,
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    defaultBranch: repo.defaultBranch,
    archived: repo.archived,
    visibility: repo.visibility,
    htmlUrl: repo.htmlUrl,
  };
}

/**
 * Syncs one discovered repository: plans its tree against the stored state, fetches only changed
 * blobs (plus a changed README or CODEOWNERS) and persists the result in one transaction. Takes no
 * lock: call it inside the repo's sync lock (`runRepos` does; `syncRepoLocked` is the standalone
 * form) and pass that lock's signal.
 *
 * Throws for a failure, so the caller records it and keeps the stored content: a `GitHubError`
 * (fatal kinds are rethrown by `syncBlobs`), a `RepoSyncError` for a truncated tree or too many
 * docs files, or a `PersistError`. An `unchanged` plan the stored row no longer matches
 * (`stale_plan`) is re-planned once from the tree, ignoring the stored head state.
 */
export async function syncRepo(
  ctx: SyncContext,
  repo: DiscoveredRepo,
  options: SyncRepoOptions = {},
): Promise<RepoSyncOutcome> {
  const { signal, listedAt } = options;
  let stored = await readStoredState(ctx.db, repo.githubId);
  for (let attempt = 0; ; attempt++) {
    const plan = await planTree(ctx.github, repo, attempt === 0 ? stored.tree : NO_TREE, {
      signal,
      selection: { docsPaths: ctx.config.defaults.docsPaths },
    });
    if (plan.outcome === "failed") {
      throw new RepoSyncError(plan.reason, { count: plan.count, limit: plan.limit });
    }

    let persistPlan: PersistPlan;
    let warnings: SyncWarning[] = [];
    if (plan.outcome === "unchanged") {
      persistPlan = {
        kind: "unchanged",
        treeSha: plan.treeSha,
        commitSha: plan.commitSha,
        headEtag: plan.headEtag,
        selectionFingerprint: plan.selectionFingerprint,
      };
    } else {
      const blobs = await syncBlobs(
        ctx.github,
        repo,
        {
          files: plan.files,
          stored: stored.docs,
          repoLevel: {
            files: plan.repoLevelFiles,
            stored: { readmeSha: stored.readmeSha, codeownersSha: stored.codeownersSha },
          },
        },
        { signal, concurrency: ctx.tuning.blobConcurrency },
      );
      warnings = [
        ...blobs.failed.map((f) => fetchFailureWarning(f.path, f.kind)),
        ...repoLevelWarning(blobs.repoLevel.readme),
        ...repoLevelWarning(blobs.repoLevel.codeowners),
      ];
      persistPlan = {
        kind: "content",
        treeSha: plan.treeSha,
        commitSha: plan.commitSha,
        headEtag: plan.headEtag,
        selectionFingerprint: plan.selectionFingerprint,
        docsFolder: plan.docsFolder,
        fetched: blobs.fetched,
        removed: blobs.removed,
        failed: blobs.failed,
        readme: blobs.repoLevel.readme,
        codeowners: blobs.repoLevel.codeowners,
      };
    }

    try {
      const persist = await persistRepoSync(
        ctx.db,
        { repo: persistRepoOf(repo), plan: persistPlan },
        { signal, listedAt },
      );
      return {
        persist,
        unchanged: plan.outcome === "unchanged",
        outcome: plan.outcome,
        selectionSkipped: plan.outcome === "unchanged" ? [] : plan.skipped,
        warnings,
      };
    } catch (error) {
      if (error instanceof PersistError && error.kind === "stale_plan" && attempt === 0) {
        stored = await readStoredState(ctx.db, repo.githubId);
        continue;
      }
      throw error;
    }
  }
}

export interface SyncRepoLockedOptions extends SyncRepoOptions {
  /** Passed to `withRepoSyncLock`. Default 0: return `busy` at once. */
  lockWaitMs?: number;
}

/**
 * `syncRepo` inside the repo's sync lock. Returns the lock result; errors from the sync reach the
 * caller unchanged. It records no status and no run: use `syncOne` for that.
 */
export async function syncRepoLocked(
  ctx: SyncContext,
  repo: DiscoveredRepo,
  options: SyncRepoLockedOptions = {},
): Promise<LockResult<RepoSyncOutcome>> {
  return withRepoSyncLock(
    ctx.pool,
    { githubId: repo.githubId },
    ({ signal }) => syncRepo(ctx, repo, { signal }),
    { signal: options.signal, waitMs: options.lockWaitMs ?? 0 },
  );
}

// ---------------------------------------------------------------------------------------------
// Shared run helpers

/**
 * The listing endpoint is scoped to the installation, so a 404 on it means the installation is
 * gone, the same as a 404 when minting its token.
 */
function listingError(error: GitHubError): GitHubError {
  return error.kind === "not_found" ? new GitHubError("installation_unavailable", 404) : error;
}

interface StoredRepoRow extends RunRepo {
  owner: string;
  name: string;
}

/**
 * Flags one stored row `error` under its repo lock (content kept), or under `held` when that is the
 * row's lock. A busy repo is left alone.
 */
async function markStoredError(
  ctx: SyncContext,
  row: RunRepo,
  message: string,
  held?: HeldRepoLock,
): Promise<void> {
  try {
    await underRepoLock(ctx.pool, row.githubId, held, () =>
      recordRepoOutcome(ctx.db, row, { status: "error", message }),
    );
  } catch {
    // Best effort: the run results still say why.
  }
}

/**
 * A failed listing: the run fails with the listing's error and nothing is deleted. For
 * installation-wide kinds the stored repos in `rows` (`"all"`, one GitHub id, or none) are marked
 * `error` with the same fixed message and reported `skipped`; other kinds leave every row as it
 * was.
 */
async function recordDiscoveryFailure(
  ctx: SyncContext,
  ledger: RunLedger,
  error: GitHubError,
  scope: "all" | number | null,
  held?: HeldRepoLock,
): Promise<SyncErrorInfo> {
  const described = describeSyncError(listingError(error), ctx.now());
  if (ledger.fatal === null) ledger.fatal = described;
  if (!INSTALLATION_WIDE_KINDS.has(described.kind) || scope === null) return described;
  const query = ctx.db
    .select({ githubId: repos.githubId, owner: repos.owner, name: repos.name })
    .from(repos);
  const rows: StoredRepoRow[] = await (scope === "all"
    ? query.orderBy(repos.id)
    : query.where(eq(repos.githubId, scope)));
  for (const row of rows) {
    await markStoredError(ctx, row, described.message, held);
    ledger.results.push(failureEntry(row, described, "skipped"));
  }
  return described;
}

/**
 * Config-listed repositories the installation cannot access: a `not_accessible` entry each. Such a
 * stored repo is absent from the complete listing, so the removal step (which runs first) deleted
 * it: its `removed` entry is annotated with the `not_accessible` kind and message instead of
 * adding a second entry; one whose removal was skipped (busy, changed) keeps that entry alone. A
 * stored row with that name the removal step did not plan (case-insensitive; one the run just
 * synced under another name is not matched) is marked `error`, content kept. Entries with no
 * stored row carry `githubId` 0 and the name as written in the config.
 */
async function recordInaccessible(
  ctx: SyncContext,
  ledger: RunLedger,
  discovery: Extract<DiscoveryResult, { complete: true }>,
  removals: readonly { outcome: RemovalOutcome; entry: SyncRepoResult }[],
): Promise<void> {
  if (discovery.inaccessible.length === 0) return;
  const described = describeSyncError(new RepoSyncError("not_accessible"), ctx.now());
  const synced = new Set(discovery.repos.map((r) => r.githubId));
  for (const missing of discovery.inaccessible) {
    const handled = removals.filter((r) => sameName(r.outcome.repo.name, missing.name));
    if (handled.length > 0) {
      for (const { outcome, entry } of handled) {
        if (outcome.status !== "removed") continue;
        entry.error = described.message;
        entry.errorKind = described.kind;
      }
      continue;
    }
    const rows = (
      await ctx.db
        .select({ githubId: repos.githubId, owner: repos.owner, name: repos.name })
        .from(repos)
        .where(sql`lower(${repos.name}) = lower(${missing.name})`)
        .orderBy(repos.id)
    ).filter((r) => !synced.has(r.githubId));
    if (rows.length === 0) {
      const entry = failureEntry({ githubId: 0, owner: "", name: missing.name }, described);
      entry.repo = missing.name;
      ledger.results.push(entry);
      continue;
    }
    for (const row of rows) {
      await markStoredError(ctx, row, described.message);
      ledger.results.push(failureEntry(row, described));
    }
  }
}

/**
 * The `runRepos` worker: one pass over one repo, under its lock. `since` is the database instant
 * taken before the run's listing; `storedAtListing` the GitHub ids stored after `since` and before
 * the listing (`storedGithubIds`).
 *
 * - When another sync (or a `privatized` webhook) wrote the repo after `since`, this run's listing
 *   is older than what is stored (for example `public` from before a `privatized` event), so the
 *   repo is skipped (`RepoSyncSkipped('superseded')`) rather than written back with stale
 *   metadata. Its rerun marker is left alone.
 * - When the repo was stored at listing time and its row is gone now, a webhook removed it after
 *   the listing (archived, deleted, renamed out of the selection, removed from the installation),
 *   so the listing is stale for it and must not recreate it: skipped
 *   (`RepoSyncSkipped('removed')`). The check runs under the repo lock, which every removal also
 *   takes, so no removal can slip in between it and persist. Why not a tombstone or a GitHub
 *   re-check: this needs no schema, no GitHub call, and costs one id query per run; a repo that
 *   is genuinely back is not in the next run's snapshot (its row is gone), so that run creates it,
 *   and a repo new to this listing (not stored at listing time) is created as before. The cost: a
 *   repo removed and re-added upstream within one run waits for the next trigger.
 * - Otherwise the repo is synced (persist guards the visibility against a `privatized` event that
 *   lands during the pass: `listedAt`), and then the requests the pass covers (marker <= `since`)
 *   are cleared, whether the pass succeeded or failed: a failed repo is in `error` and is retried
 *   by the next request or full sync, not in a loop. An aborted pass or a lost lock clears nothing.
 */
function worker(ctx: SyncContext, since: DbInstant, storedAtListing: ReadonlySet<number>) {
  return async (repo: DiscoveredRepo, { signal }: { signal: AbortSignal }) => {
    const state = await storedStateSince(ctx.db, repo.githubId, since);
    if (state === "written") throw new RepoSyncSkipped("superseded");
    if (state === "missing" && storedAtListing.has(repo.githubId)) {
      throw new RepoSyncSkipped("removed");
    }
    try {
      return await syncRepo(ctx, repo, { signal, listedAt: since });
    } finally {
      if (!signal.aborted) {
        await clearSyncRequest(ctx.db, repo.githubId, since).catch(() => false);
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------
// syncAll

export interface SyncAllOptions {
  trigger: RunTrigger;
  signal?: AbortSignal;
  /** Passed to the drain's `requestSync` calls (see `RequestSyncOptions.rearm`). */
  rearm?(task: Promise<void>): void;
}

export interface SyncAllResult {
  /** The run as `withRun` reported it; `value` is the per-repo results when it ran. */
  run: WithRunResult<SyncRepoResult[]>;
  /**
   * The listing narrowed by config, or null when the run did not get as far as listing. The
   * removal step acts on it only when `discovery.complete` is true.
   */
  discovery: DiscoveryResult | null;
  /** GitHub ids of the repositories this run attempted (`discovery.repos`), in listing order. */
  discoveredGithubIds: number[];
  /** What the removal step did per planned repo (task 5.9); empty when it did not run. */
  removals: RemovalOutcome[];
  /**
   * Waiting sync requests run after the run (task 6.4, `drainSyncRequests`): requests that arrived
   * while this run held a repo, repos this run found busy, markers left by a crashed process.
   * Empty when the run did not finish cleanly.
   */
  drained: DrainedRequest[];
  /** The error that stopped the run (failed listing, rate limit, ...), or null. Fixed messages only. */
  fatal: SyncErrorInfo | null;
}

/**
 * Whether the removal step may run after the repo loop. The listing was complete (the caller
 * checks), so removal needs nothing from GitHub; it is still skipped after an abort or an
 * installation-wide failure (the installation may have just been suspended, whose rule is "keep
 * content"). A rate limit does not block it, or a large org that always hits the limit would
 * never drop a repo.
 */
function removalAllowed(ledger: RunLedger, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  return ledger.fatal === null || ledger.fatal.kind === "rate_limited";
}

/**
 * A full sync run. Reaps stale runs first, then inside `withRun` (scope null): lists the
 * installation's repositories narrowed by config, syncs each discovered repo in its repo lock
 * (`runRepos`: per-repo failures are isolated, fatal ones stop the run), removes stored repos the
 * complete listing no longer selects (`planRemovals`/`executeRemovals`, recorded as `removed`
 * entries), and reports config-listed repos the installation cannot access. A failed listing
 * fails the run and deletes nothing.
 *
 * Coalescing (task 6.4): a repo whose lock is busy is not lost. Its rerun marker is set, and after
 * the run every waiting request is drained (`drainSyncRequests`): the drain's own try-lock comes
 * after the marker, so either it syncs the repo or the holder still holds the lock and reruns
 * when it lets go.
 *
 * The drain is skipped after a fatal error (a rate limit, an installation-wide failure) or an
 * abort: it would hit the same wall. Markers are left set in the database (repos not reached,
 * busy repos, requests newer than the run, rows kept private against a stale listing), and
 * nothing is lost meanwhile: stored rows stay fail-closed (persist never writes a stale `public`
 * over a newer `private`). The next full sync's drain, or a startup or periodic
 * `drainSyncRequests` (tasks 12.x), runs them.
 */
export async function syncAll(ctx: SyncContext, options: SyncAllOptions): Promise<SyncAllResult> {
  await reapStaleRuns(ctx.db, ctx.pool);
  let discovery: DiscoveryResult | null = null;
  let removals: RemovalOutcome[] = [];
  let fatal: SyncErrorInfo | null = null;
  const run = await withRun(
    ctx.db,
    ctx.pool,
    { trigger: options.trigger, scope: null, signal: options.signal },
    async ({ signal, ledger }) => {
      // Taken before the listing: rows a concurrent sync writes after it are not removed, and
      // requests newer than it are not consumed by this run.
      const listedAt = await databaseNow(ctx.db);
      const since = await databaseInstant(ctx.db);
      const storedAtListing = await storedGithubIds(ctx.db);
      discovery = await discoverRepositories(ctx.github, ctx.config, { signal });
      if (!discovery.complete) {
        await recordDiscoveryFailure(ctx, ledger, discovery.error, "all");
        fatal = ledger.fatal;
        return [...ledger.results];
      }
      const synced = await runRepos(
        ctx.db,
        ctx.pool,
        discovery.repos,
        worker(ctx, since, storedAtListing),
        {
          signal,
          concurrency: ctx.tuning.repoConcurrency,
          lockWaitMs: ctx.tuning.lockWaitMs,
          listedAt: since,
          now: ctx.now,
        },
      );
      // A busy repo is held by another sync: record the request so it is synced after that one.
      for (const entry of synced.results) {
        if (entry.status === "skipped" && entry.errorKind === "busy") {
          await markSyncRequested(ctx.db, entry.githubId).catch(() => false);
        }
      }
      ledger.add(synced);
      const handled: { outcome: RemovalOutcome; entry: SyncRepoResult }[] = [];
      if (removalAllowed(ledger, signal)) {
        const planned = planRemovals({
          stored: await readStoredRepos(ctx.db),
          discovery,
          config: ctx.config,
        });
        removals = await executeRemovals(ctx.db, ctx.pool, planned, {
          discoveredGithubIds: discovery.repos.map((r) => r.githubId),
          listedAt,
          signal,
        });
        for (const outcome of removals) {
          const entry = removalOutcomeEntry(outcome);
          handled.push({ outcome, entry });
          ledger.results.push(entry);
        }
      }
      if (ledger.fatal === null) await recordInaccessible(ctx, ledger, discovery, handled);
      fatal = ledger.fatal;
      return [...ledger.results];
    },
  );
  const found = discovery as DiscoveryResult | null;
  const drained =
    run.ran && fatal === null && options.signal?.aborted !== true
      ? await drainSyncRequests(ctx, {
          trigger: options.trigger,
          signal: options.signal,
          rearm: options.rearm,
        })
      : [];
  return {
    run,
    discovery: found,
    discoveredGithubIds: found?.complete ? found.repos.map((r) => r.githubId) : [],
    removals,
    drained,
    fatal,
  };
}

// ---------------------------------------------------------------------------------------------
// syncOne

/**
 * A repository by name (the owner is optional: an installation belongs to one account, so the name
 * is unambiguous there) or by GitHub id.
 */
export type SyncOneTarget = { owner?: string; name: string } | { githubId: number };

export interface SyncOneOptions {
  trigger: RunTrigger;
  signal?: AbortSignal;
  /**
   * The caller already holds this repo's sync lock (`requestSync`). Only with a `{ githubId }`
   * target of the same id; the run then syncs under that lock instead of taking it.
   */
  heldLock?: HeldRepoLock;
}

export type SyncOneResult =
  | {
      status: "synced";
      run: WithRunResult<SyncRepoResult[]>;
      repo: DiscoveredRepo;
      /** This repo's entry, when the run ran. Its `status` may be `error` or `skipped` (busy). */
      result: SyncRepoResult | null;
      discovery: DiscoveryResult;
    }
  | {
      /** The installation cannot access a repository by that name or id. No run is recorded. */
      status: "not_found";
      discovery: DiscoveryResult;
    }
  | {
      /** Accessible, but the config narrowing leaves it out (or it is archived). No run. */
      status: "not_configured";
      reason: "excluded" | "archived" | "not_listed";
      discovery: DiscoveryResult;
    }
  | {
      /** The listing failed: a failed run is recorded and nothing is deleted. */
      status: "discovery_failed";
      run: WithRunResult<SyncRepoResult[]>;
      error: SyncErrorInfo;
      discovery: DiscoveryResult;
    };

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function matches(target: SyncOneTarget, repo: { githubId: number; owner: string; name: string }) {
  return "githubId" in target
    ? repo.githubId === target.githubId
    : (target.owner === undefined || sameName(repo.owner, target.owner)) &&
        sameName(repo.name, target.name);
}

function validateTarget(target: SyncOneTarget): void {
  if ("githubId" in target) {
    if (!Number.isSafeInteger(target.githubId) || target.githubId < 1) {
      throw new TypeError("githubId must be a positive integer");
    }
  } else if (
    (target.owner !== undefined && (typeof target.owner !== "string" || target.owner === "")) ||
    typeof target.name !== "string" ||
    target.name === ""
  ) {
    throw new TypeError("name (and owner, when given) must be non-empty strings");
  }
}

/**
 * Syncs one repository in its own run (`scope` = its `owner/name`), for `POST /api/sync` and
 * webhooks. The repository is resolved through the installation listing and the config
 * narrowing, so a repo the App cannot see (`not_found`) or the config leaves out
 * (`not_configured`) is reported without starting a run and without touching stored rows. A
 * failed listing records a failed run (scope: the target's `owner/name` when known, else
 * `github:<id>`), marks the target's stored row `error` for installation-wide kinds, and deletes
 * nothing.
 */
export async function syncOne(
  ctx: SyncContext,
  target: SyncOneTarget,
  options: SyncOneOptions,
): Promise<SyncOneResult> {
  validateTarget(target);
  const held = options.heldLock;
  if (held !== undefined && !("githubId" in target && target.githubId === held.githubId)) {
    throw new TypeError("heldLock needs a { githubId } target of the same repository");
  }
  await reapStaleRuns(ctx.db, ctx.pool);
  const since = await databaseInstant(ctx.db);
  const storedAtListing = await storedGithubIds(
    ctx.db,
    "githubId" in target ? target.githubId : undefined,
  );
  const discovery = await discoverRepositories(ctx.github, ctx.config, { signal: options.signal });
  if (!discovery.complete) return listingFailed(ctx, target, discovery, options);

  const found = await resolveListed(ctx, target, discovery);
  if (!("repo" in found)) return found;
  const { repo } = found;

  const run = await withRun(
    ctx.db,
    ctx.pool,
    { trigger: options.trigger, scope: `${repo.owner}/${repo.name}`, signal: options.signal },
    async ({ signal, ledger }) => {
      ledger.add(
        await runRepos(ctx.db, ctx.pool, [repo], worker(ctx, since, storedAtListing), {
          signal,
          lockWaitMs: ctx.tuning.lockWaitMs,
          listedAt: since,
          now: ctx.now,
          heldLock: held,
        }),
      );
      return [...ledger.results];
    },
  );
  const result = run.ran ? (run.value[0] ?? null) : null;
  return { status: "synced", run, repo, result, discovery };
}

/** The target in a complete listing, or why it is not synced (`not_found`, `not_configured`). */
async function resolveListed(
  ctx: SyncContext,
  target: SyncOneTarget,
  discovery: Extract<DiscoveryResult, { complete: true }>,
): Promise<
  { repo: DiscoveredRepo } | Extract<SyncOneResult, { status: "not_found" | "not_configured" }>
> {
  const repo = discovery.repos.find((r) => matches(target, r));
  if (repo !== undefined) return { repo };
  const skipped = discovery.skipped.find((r) => matches(target, r));
  if (skipped !== undefined) return { status: "not_configured", reason: skipped.reason, discovery };
  if (ctx.config.repos !== undefined) {
    const name = "githubId" in target ? (await findStoredRow(ctx, target))?.name : target.name;
    const listed = ctx.config.repos.some((e) =>
      sameName(typeof e === "string" ? e : e.name, name ?? ""),
    );
    if (name !== undefined && !listed) {
      return { status: "not_configured", reason: "not_listed", discovery };
    }
  }
  return { status: "not_found", discovery };
}

/**
 * A failed listing for a single-repo sync: records a failed run (scope: the target's
 * `owner/name` when known, else `github:<id>`) and, for installation-wide kinds, marks the
 * target's stored row `error`. Deletes nothing.
 */
async function listingFailed(
  ctx: SyncContext,
  target: SyncOneTarget,
  discovery: Extract<DiscoveryResult, { complete: false }>,
  options: SyncOneOptions,
): Promise<SyncOneResult> {
  const stored = await findStoredRow(ctx, target);
  const scope =
    "githubId" in target
      ? stored
        ? `${stored.owner}/${stored.name}`
        : `github:${target.githubId}`
      : stored
        ? `${stored.owner}/${stored.name}`
        : target.owner === undefined
          ? target.name
          : `${target.owner}/${target.name}`;
  let error: SyncErrorInfo = describeSyncError(listingError(discovery.error), ctx.now());
  const run = await withRun(
    ctx.db,
    ctx.pool,
    { trigger: options.trigger, scope, signal: options.signal },
    async ({ ledger }) => {
      error = await recordDiscoveryFailure(
        ctx,
        ledger,
        discovery.error,
        stored?.githubId ?? null,
        options.heldLock,
      );
      return [...ledger.results];
    },
  );
  return { status: "discovery_failed", run, error, discovery };
}

async function findStoredRow(
  ctx: SyncContext,
  target: SyncOneTarget,
): Promise<StoredRepoRow | undefined> {
  const where =
    "githubId" in target
      ? eq(repos.githubId, target.githubId)
      : target.owner === undefined
        ? sql`lower(${repos.name}) = lower(${target.name})`
        : sql`lower(${repos.owner}) = lower(${target.owner}) and lower(${repos.name}) = lower(${target.name})`;
  const [row] = await ctx.db
    .select({ githubId: repos.githubId, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(where)
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------------------------
// requestSync: coalesced single-repo syncs (task 6.4)

/** Passes one `requestSync` call runs before it hands a still-waiting request to `rearm`. */
export const DEFAULT_MAX_PASSES = 5;
/** How long a request for a repo with no stored row keeps retrying a busy lock (see below). */
export const DEFAULT_QUEUE_WAIT_MS = 10 * 60_000;
const QUEUE_FIRST_DELAY_MS = 50;
const QUEUE_MAX_DELAY_MS = 1_000;

/** Test seams: each runs at one point of the protocol and may pause it. */
export interface RequestSyncHooks {
  /** After the marker write (`marked` false: no stored row), before the lock is tried. */
  afterMark?(state: { githubId: number; marked: boolean }): void | Promise<void>;
  /**
   * Under the lock, after the pass's start instant was taken, before it reads GitHub. `lock.signal`
   * is the held lock's signal (aborts when its connection is lost).
   */
  passStart?(pass: number, lock: { signal: AbortSignal }): void | Promise<void>;
  /** Under the lock, after the pass finished and cleared what it covered, before unlocking. */
  beforeUnlock?(pass: number): void | Promise<void>;
  /** After the lock was released, before the marker is rechecked. */
  afterUnlock?(pass: number): void | Promise<void>;
  /** Sleep between queue attempts. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RequestSyncOptions {
  trigger: RunTrigger;
  signal?: AbortSignal;
  /** Default `DEFAULT_MAX_PASSES`. */
  maxPasses?: number;
  /**
   * A repo with no stored row cannot hold a marker, so a request for it that finds the lock busy
   * keeps retrying (re-marking each time, since the holder's first sync may create the row) for
   * up to this long, then reports `busy`. Default `DEFAULT_QUEUE_WAIT_MS`; 0 reports `busy` at once.
   */
  queueWaitMs?: number;
  /**
   * Takes the follow-up call started when `maxPasses` passes ran and a request is still waiting.
   * The task never rejects. Default: run it unawaited.
   */
  rearm?(task: Promise<void>): void;
  hooks?: RequestSyncHooks;
}

export type RequestSyncResult =
  | {
      /**
       * This call ran `passes` passes (0 when a name target was not found, not configured, or the
       * listing failed). `result` is the last pass's. `handedOff`: a request is still waiting and
       * belongs to another holder of the lock, to the `rearm` task, or (after a pass whose listing
       * failed or whose lock was lost) to a later drain.
       */
      status: "done";
      passes: number;
      result: SyncOneResult;
      handedOff: boolean;
    }
  /** Another sync holds the repo. The request is recorded; that holder runs again for it. */
  | { status: "coalesced"; passes: 0 }
  /** The repo has no stored row and its lock stayed busy for `queueWaitMs`: nothing recorded. */
  | { status: "busy"; passes: 0 }
  /** The caller's signal aborted. Any waiting request stays recorded. */
  | { status: "aborted"; passes: number; result: SyncOneResult | null };

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Requests a sync of one repository and coalesces it with any sync already running for it
 * (webhooks spec, "Idempotent processing"; design decision 4, "Busy is not a no-op").
 *
 * 1. The request is recorded first: the repo's marker is set (`markSyncRequested`).
 * 2. The repo lock is tried once. Busy: the result is `coalesced`; the holder will see the marker.
 * 3. Acquired: one pass runs under the lock: a start instant, then `syncOne` under the held lock
 *    (fresh listing, tree, blobs, persist), then the marker is cleared if it is not newer than
 *    the start instant. The lock is released, and only then the marker is rechecked: when it is
 *    set (a request arrived during the pass), another pass runs (back to the try-lock).
 *
 * Why nothing is lost: a requester's try-lock fails only while some holder holds the lock, and the
 * requester's marker was written before that attempt, so it is in place before that holder
 * unlocks and rechecks. A request that arrived during a pass is newer than the pass's start
 * instant and survives the clear. Passes of one repo never overlap (the lock), and passes of
 * different repos run in parallel (different locks).
 *
 * A pass that fails still clears the requests it covered (the repo shows `error`; the next
 * request or full sync retries, not a loop). An aborted pass, a lost lock, or a pass whose listing
 * failed clears nothing, and the call stops there (no further pass); a crashed process leaves its
 * marker too. `drainSyncRequests` (end of `syncAll`, or a startup/periodic drain) picks it up.
 *
 * At most `maxPasses` passes run per call, so a repo that keeps receiving pushes cannot hold one
 * caller forever; a request still waiting then goes to `rearm` as a fresh call.
 *
 * A name target is first resolved through the installation listing (an unknown, unconfigured, or
 * failed-listing target is returned as `done` with no pass); each pass lists again under the lock.
 */
export async function requestSync(
  ctx: SyncContext,
  target: SyncOneTarget,
  options: RequestSyncOptions,
): Promise<RequestSyncResult> {
  validateTarget(target);
  const maxPasses = positiveInt(options.maxPasses ?? DEFAULT_MAX_PASSES, "maxPasses");
  const queueWaitMs = options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS;
  if (typeof queueWaitMs !== "number" || Number.isNaN(queueWaitMs) || queueWaitMs < 0) {
    throw new TypeError("queueWaitMs must be a number >= 0");
  }
  const { signal, trigger } = options;
  const hooks = options.hooks ?? {};
  const sleep = hooks.sleep ?? abortableSleep;

  let githubId: number;
  if ("githubId" in target) {
    githubId = target.githubId;
  } else {
    await reapStaleRuns(ctx.db, ctx.pool);
    const discovery = await discoverRepositories(ctx.github, ctx.config, { signal });
    const outcome = discovery.complete
      ? await resolveListed(ctx, target, discovery)
      : await listingFailed(ctx, target, discovery, options);
    if (!("repo" in outcome))
      return { status: "done", passes: 0, result: outcome, handedOff: false };
    githubId = outcome.repo.githubId;
  }

  const deadline = ctx.now() + queueWaitMs;
  let delay = QUEUE_FIRST_DELAY_MS;
  let passes = 0;
  let last: SyncOneResult | null = null;
  let marked = await markSyncRequested(ctx.db, githubId);
  await hooks.afterMark?.({ githubId, marked });

  for (;;) {
    const pass = passes + 1;
    const lock = await withRepoSyncLock(
      ctx.pool,
      { githubId },
      async (held) => {
        const since = await databaseInstant(ctx.db);
        await hooks.passStart?.(pass, { signal: held.signal });
        const result = await syncOne(
          ctx,
          { githubId },
          { trigger, signal, heldLock: { githubId, signal: held.signal } },
        );
        // A pass whose listing failed read nothing fresh from GitHub (not even the visibility),
        // so it covers no request: the marker stays for a later drain.
        const lost = held.signal.aborted;
        if (!lost && result.status !== "discovery_failed") {
          await clearSyncRequest(ctx.db, githubId, since).catch(() => false);
        }
        await hooks.beforeUnlock?.(pass);
        return { result, lost };
      },
      { signal },
    );

    if (!lock.acquired) {
      if (lock.reason !== "busy") return { status: "aborted", passes, result: last };
      if (last !== null) return { status: "done", passes, result: last, handedOff: true };
      if (marked) return { status: "coalesced", passes: 0 };
      // No stored row, so no marker the holder could see: wait for the lock (queued), re-marking
      // each time in case the holder's first sync created the row meanwhile.
      if (ctx.now() >= deadline) return { status: "busy", passes: 0 };
      await sleep(delay, signal);
      if (signal?.aborted) return { status: "aborted", passes, result: last };
      delay = Math.min(delay * 2, QUEUE_MAX_DELAY_MS);
      marked = await markSyncRequested(ctx.db, githubId);
      continue;
    }

    passes = pass;
    last = lock.value.result;
    if (signal?.aborted) return { status: "aborted", passes, result: last };
    // A failed listing or a lost lock (database connection problem) would fail the same way
    // again at once: stop here and leave the marker to a later drain instead of looping.
    if (lock.value.lost || last.status === "discovery_failed") {
      return { status: "done", passes, result: last, handedOff: true };
    }
    await hooks.afterUnlock?.(pass);
    if (!(await isSyncRequested(ctx.db, githubId))) {
      return { status: "done", passes, result: last, handedOff: false };
    }
    if (passes >= maxPasses) {
      const follow = Promise.resolve()
        .then(() => requestSync(ctx, { githubId }, options))
        .then(
          () => undefined,
          () => undefined,
        );
      try {
        if (options.rearm) options.rearm(follow);
      } catch {
        // The follow-up runs regardless; a broken scheduler only loses tracking.
      }
      return { status: "done", passes, result: last, handedOff: true };
    }
    marked = true;
  }
}

/** One drained request: the repo and what `requestSync` did. */
export interface DrainedRequest {
  githubId: number;
  status: RequestSyncResult["status"];
  passes: number;
}

export interface DrainOptions {
  trigger: RunTrigger;
  signal?: AbortSignal;
  /** Passed to each `requestSync`. */
  rearm?(task: Promise<void>): void;
}

/**
 * Runs every waiting sync request (repos whose marker is set), one repo at a time, oldest request
 * first, each through `requestSync` (so a busy repo is left to its holder). `syncAll` calls it at
 * the end; a startup or periodic drain (tasks 12.x) can call it to pick up markers a crashed
 * process or a fatal full sync left. A failure on one repo is reported and the drain goes on,
 * except a failed installation listing: every request needs that listing, so the drain stops
 * and the remaining markers stay set for the next drain.
 */
export async function drainSyncRequests(
  ctx: SyncContext,
  options: DrainOptions,
): Promise<DrainedRequest[]> {
  const out: DrainedRequest[] = [];
  for (const githubId of await listSyncRequests(ctx.db)) {
    if (options.signal?.aborted) break;
    try {
      const result = await requestSync(
        ctx,
        { githubId },
        { trigger: options.trigger, signal: options.signal, queueWaitMs: 0, rearm: options.rearm },
      );
      out.push({ githubId, status: result.status, passes: result.passes });
      if (result.status === "done" && result.result.status === "discovery_failed") break;
    } catch {
      out.push({ githubId, status: "aborted", passes: 0 });
    }
  }
  return out;
}
