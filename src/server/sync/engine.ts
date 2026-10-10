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
  INSTALLATION_WIDE_KINDS,
  RepoSyncError,
  describeSyncError,
  failureEntry,
  reapStaleRuns,
  recordRepoOutcome,
  runRepos,
  withRun,
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
 *   repositories narrowed by config, and syncs each one. Nothing is ever deleted here: removal of
 *   repos dropped from config or from the installation is task 5.9, which gets what it needs from
 *   the returned `discovery` (only act on it when `discovery.complete`).
 * - `syncOne`: a single-repo run for `POST /api/sync` and webhooks (6.x). The repo must be in the
 *   installation listing and pass the config narrowing; otherwise a typed `not_found` or
 *   `not_configured` result is returned and no run is recorded.
 *
 * Inputs are injected through a `SyncContext` (database, pool, GitHub client, validated config);
 * nothing here reads the environment or files. `src/server/runtime.ts` builds the context.
 *
 * Failure handling follows the design's removal rule: a failed repo keeps its stored content and
 * is marked `error` with a fixed message; a failed listing deletes nothing. Installation-wide
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
  const { signal } = options;
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
        { signal },
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

/** Flags one stored row `error` under its repo lock (content kept). A busy repo is left alone. */
async function markStoredError(ctx: SyncContext, row: RunRepo, message: string): Promise<void> {
  try {
    await withRepoSyncLock(ctx.pool, { githubId: row.githubId }, () =>
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
    await markStoredError(ctx, row, described.message);
    ledger.results.push(failureEntry(row, described, "skipped"));
  }
  return described;
}

/**
 * Config-listed repositories the installation cannot access: a `not_accessible` entry each, and a
 * stored row with that name (case-insensitive; one the run just synced under another name is not
 * matched) is marked `error`, content kept. Entries with no stored row carry `githubId` 0 and the
 * name as written in the config.
 */
async function recordInaccessible(
  ctx: SyncContext,
  ledger: RunLedger,
  discovery: Extract<DiscoveryResult, { complete: true }>,
): Promise<void> {
  if (discovery.inaccessible.length === 0) return;
  const described = describeSyncError(new RepoSyncError("not_accessible"), ctx.now());
  const synced = new Set(discovery.repos.map((r) => r.githubId));
  for (const missing of discovery.inaccessible) {
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

function worker(ctx: SyncContext) {
  return (repo: DiscoveredRepo, { signal }: { signal: AbortSignal }) =>
    syncRepo(ctx, repo, { signal });
}

// ---------------------------------------------------------------------------------------------
// syncAll

export interface SyncAllOptions {
  trigger: RunTrigger;
  signal?: AbortSignal;
}

export interface SyncAllResult {
  /** The run as `withRun` reported it; `value` is the per-repo results when it ran. */
  run: WithRunResult<SyncRepoResult[]>;
  /**
   * The listing narrowed by config, or null when the run did not get as far as listing. Task 5.9
   * may remove stored repos missing from `discovery.repos` ONLY when `discovery.complete` is true.
   */
  discovery: DiscoveryResult | null;
  /** GitHub ids of the repositories this run attempted (`discovery.repos`), in listing order. */
  discoveredGithubIds: number[];
}

/**
 * A full sync run. Reaps stale runs first, then inside `withRun` (scope null): lists the
 * installation's repositories narrowed by config, syncs each discovered repo in its repo lock
 * (`runRepos`: per-repo failures are isolated, fatal ones stop the run), and reports config-listed
 * repos the installation cannot access. A failed listing fails the run and deletes nothing.
 * Deletes no repos (task 5.9).
 */
export async function syncAll(ctx: SyncContext, options: SyncAllOptions): Promise<SyncAllResult> {
  await reapStaleRuns(ctx.db, ctx.pool);
  let discovery: DiscoveryResult | null = null;
  const run = await withRun(
    ctx.db,
    ctx.pool,
    { trigger: options.trigger, scope: null, signal: options.signal },
    async ({ signal, ledger }) => {
      discovery = await discoverRepositories(ctx.github, ctx.config, { signal });
      if (!discovery.complete) {
        await recordDiscoveryFailure(ctx, ledger, discovery.error, "all");
        return [...ledger.results];
      }
      ledger.add(
        await runRepos(ctx.db, ctx.pool, discovery.repos, worker(ctx), {
          signal,
          concurrency: ctx.tuning.repoConcurrency,
          lockWaitMs: ctx.tuning.lockWaitMs,
          now: ctx.now,
        }),
      );
      if (ledger.fatal === null) await recordInaccessible(ctx, ledger, discovery);
      return [...ledger.results];
    },
  );
  const found = discovery as DiscoveryResult | null;
  return {
    run,
    discovery: found,
    discoveredGithubIds: found?.complete ? found.repos.map((r) => r.githubId) : [],
  };
}

// ---------------------------------------------------------------------------------------------
// syncOne

export type SyncOneTarget = { owner: string; name: string } | { githubId: number };

export interface SyncOneOptions {
  trigger: RunTrigger;
  signal?: AbortSignal;
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
    : sameName(repo.owner, target.owner) && sameName(repo.name, target.name);
}

function validateTarget(target: SyncOneTarget): void {
  if ("githubId" in target) {
    if (!Number.isSafeInteger(target.githubId) || target.githubId < 1) {
      throw new TypeError("githubId must be a positive integer");
    }
  } else if (
    typeof target.owner !== "string" ||
    typeof target.name !== "string" ||
    target.owner === "" ||
    target.name === ""
  ) {
    throw new TypeError("owner and name must be non-empty strings");
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
  await reapStaleRuns(ctx.db, ctx.pool);
  const discovery = await discoverRepositories(ctx.github, ctx.config, { signal: options.signal });

  if (!discovery.complete) {
    const stored = await findStoredRow(ctx, target);
    const scope =
      "githubId" in target
        ? stored
          ? `${stored.owner}/${stored.name}`
          : `github:${target.githubId}`
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
        );
        return [...ledger.results];
      },
    );
    return { status: "discovery_failed", run, error, discovery };
  }

  const repo = discovery.repos.find((r) => matches(target, r));
  if (repo === undefined) {
    const skipped = discovery.skipped.find((r) => matches(target, r));
    if (skipped !== undefined)
      return { status: "not_configured", reason: skipped.reason, discovery };
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

  const run = await withRun(
    ctx.db,
    ctx.pool,
    { trigger: options.trigger, scope: `${repo.owner}/${repo.name}`, signal: options.signal },
    async ({ signal, ledger }) => {
      ledger.add(
        await runRepos(ctx.db, ctx.pool, [repo], worker(ctx), {
          signal,
          lockWaitMs: ctx.tuning.lockWaitMs,
          now: ctx.now,
        }),
      );
      return [...ledger.results];
    },
  );
  const result = run.ran ? (run.value[0] ?? null) : null;
  return { status: "synced", run, repo, result, discovery };
}

async function findStoredRow(
  ctx: SyncContext,
  target: SyncOneTarget,
): Promise<StoredRepoRow | undefined> {
  const where =
    "githubId" in target
      ? eq(repos.githubId, target.githubId)
      : sql`lower(${repos.owner}) = lower(${target.owner}) and lower(${repos.name}) = lower(${target.name})`;
  const [row] = await ctx.db
    .select({ githubId: repos.githubId, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(where)
    .limit(1);
  return row;
}
