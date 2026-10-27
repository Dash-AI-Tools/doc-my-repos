import "server-only";

import { and, asc, desc, eq, ne, sql, type SQL } from "drizzle-orm";

import { parseSyncWarnings } from "@docmyrepos/core/internal/sync-warnings";
import type { Db } from "../db/client";
import { repos, syncRuns } from "../db/schema";
import { repoCondition, type RepoRef } from "./repo-ref";
import type { RepoSyncStatus, RepoVisibility } from "./repos";
import { visibleRepos, type QueryOptions } from "./visibility";

/**
 * Sync status reads (task 12.2): the last sync run and every visible repository's sync state for
 * `/status` and `GET /api/status`, and one repository's last run for its header.
 *
 * Visibility. Repository entries come from `repos` through `visibleRepos(options)`, like every
 * other read. `sync_runs` has no foreign key to `repos` (a run outlives a removed repo), and its
 * `scope` and per-repo `results` name repositories, so a run is joined to the filter as well:
 * - A run is shown only when it was a full run (`scope` null) or its `scope` is the `owner/name`
 *   of a visible repository. A single-repo run of a hidden, removed or unknown repository is
 *   skipped, so its name never appears; the previous visible run is shown instead.
 * - Run counts are computed from the run's `results` entries whose `githubId` is a visible stored
 *   repository, never from the run's counter columns (those count hidden repos too). Entries
 *   without a visible row (repos removed by that run, config repos the App cannot access, repos
 *   whose first sync failed) are therefore not counted: their visibility cannot be decided, so
 *   they are left out (fail closed). Only the first `MAX_RESULT_REPOS` (500) entries of a run are
 *   stored, so a larger run is counted over those.
 * - The run's `error` is a fixed text (`describeSyncError`), safe to show.
 *
 * Nothing internal is returned: no run id, tree SHA, fingerprint, rerun marker, lock or stack.
 */

export type SyncRunTrigger = "webhook" | "manual" | "schedule" | "startup";
export type SyncRunOutcome = "success" | "partial" | "failed";

/** Counts over the visible repositories of one run. */
export interface SyncRunCounts {
  /** Visible repositories the run synced or tried to sync. */
  readonly repos: number;
  /** Synced with changes or unchanged. */
  readonly ok: number;
  readonly failed: number;
  /** Not attempted (another sync held the repo, or the run stopped early). */
  readonly skipped: number;
  readonly docsAdded: number;
  readonly docsUpdated: number;
  readonly docsRemoved: number;
  readonly docsSkipped: number;
  /** Warnings recorded (malformed frontmatter, skipped files, failed fetches). */
  readonly warnings: number;
}

export interface SyncRunSummary {
  readonly trigger: SyncRunTrigger;
  /** `owner/name` of a single-repo run (stored spelling at run time), null for a full run. */
  readonly scope: string | null;
  readonly status: SyncRunOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly durationMs: number | null;
  /** Why the run stopped (fixed text), or null. */
  readonly error: string | null;
  readonly counts: SyncRunCounts;
}

export interface RunningSync {
  readonly trigger: SyncRunTrigger;
  readonly scope: string | null;
  readonly startedAt: Date;
}

export interface RepoWarningSummary {
  readonly code: string;
  readonly message: string;
  readonly count: number;
}

/** One visible repository's sync state. */
export interface RepoSyncState {
  readonly owner: string;
  readonly name: string;
  readonly visibility: RepoVisibility;
  readonly syncStatus: RepoSyncStatus;
  /** Fixed, safe text (see `RepoSummary.syncError`), clipped to 500 characters. */
  readonly syncError: string | null;
  readonly lastSyncedAt: Date | null;
  /** The repository's visible sync warnings without their paths. */
  readonly warnings: readonly RepoWarningSummary[];
  /** Files left out across those warnings. */
  readonly skippedFiles: number;
}

export interface SyncStatus {
  /** The latest finished run the reader may see, or null. */
  readonly lastRun: SyncRunSummary | null;
  /** The latest run still running the reader may see, or null. */
  readonly running: RunningSync | null;
  /** Visible repositories ordered by owner then name, at most `limit`. */
  readonly repos: readonly RepoSyncState[];
  /** Every visible repository, also those past `limit`. */
  readonly reposTotal: number;
  /** Counts of `reposTotal` by sync status. */
  readonly reposByStatus: { readonly ok: number; readonly error: number; readonly pending: number };
  /** Visible repositories with at least one sync warning. */
  readonly reposWithWarnings: number;
  /** True when `repos` was cut at `limit`. */
  readonly truncated: boolean;
}

export interface SyncStatusArgs {
  /** Most repositories listed (1 to `MAX_STATUS_REPOS`). Default `MAX_STATUS_REPOS`. */
  readonly limit?: number;
}

/** One repository's latest run. */
export interface RepoLastRun {
  readonly trigger: SyncRunTrigger;
  /** Whether that run covered every repository (null scope) or only this one. */
  readonly fullRun: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  /** This repository's outcome in that run. */
  readonly outcome: "ok" | "unchanged" | "error" | "skipped";
  /** Fixed text for `error` and `skipped`, else null. */
  readonly error: string | null;
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly skipped: number;
  readonly warnings: number;
}

export const MAX_STATUS_REPOS = 500;
/** How many recent runs are searched for a repository's last run. */
export const REPO_RUN_LOOKBACK = 200;
const MAX_TEXT = 500;

const TRIGGERS: ReadonlySet<string> = new Set(["webhook", "manual", "schedule", "startup"]);
const OUTCOMES: ReadonlySet<string> = new Set(["ok", "unchanged", "error", "skipped"]);

function clip(value: string | null): string | null {
  return value === null || value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT - 1)}…`;
}

function int(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function trigger(value: unknown): SyncRunTrigger {
  return (typeof value === "string" && TRIGGERS.has(value) ? value : "manual") as SyncRunTrigger;
}

/**
 * A run the reader may see: a full run, or a single-repo run whose scope names a visible repository
 * (case-insensitive, like every `owner/name` lookup).
 */
function visibleRun(options: QueryOptions): SQL {
  return sql`(${syncRuns.scope} is null or exists (select 1 from ${repos} where ${visibleRepos(options)} and lower(${repos.owner} || '/' || ${repos.name}) = lower(${syncRuns.scope})))`;
}

/** Counts over the run's results entries of visible repositories. */
async function runCounts(db: Db, runId: number, options: QueryOptions): Promise<SyncRunCounts> {
  const result = await db.execute(sql`
    select e.value->>'status' as "status",
      e.value->'added' as "added", e.value->'updated' as "updated",
      e.value->'removed' as "removed", e.value->'skipped' as "skipped",
      e.value->'warningsTotal' as "warnings"
    from ${syncRuns}
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(${syncRuns.results}) = 'array' then ${syncRuns.results} else '[]'::jsonb end
    ) as e(value)
    inner join ${repos} on ${repos.githubId} = (
      case when jsonb_typeof(e.value->'githubId') = 'number' then (e.value->>'githubId')::numeric end
    )
    where ${syncRuns.id} = ${runId} and ${visibleRepos(options)}
  `);
  const counts = {
    repos: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    docsAdded: 0,
    docsUpdated: 0,
    docsRemoved: 0,
    docsSkipped: 0,
    warnings: 0,
  };
  for (const row of result.rows) {
    const status = row.status;
    if (status === "removed") continue;
    counts.repos++;
    if (status === "ok" || status === "unchanged") counts.ok++;
    else if (status === "error") counts.failed++;
    else counts.skipped++;
    counts.docsAdded += int(row.added);
    counts.docsUpdated += int(row.updated);
    counts.docsRemoved += int(row.removed);
    counts.docsSkipped += int(row.skipped);
    counts.warnings += int(row.warnings);
  }
  return counts;
}

function statusLimit(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_STATUS_REPOS
    ? value
    : MAX_STATUS_REPOS;
}

/**
 * The sync status page and API: the latest finished run and the latest running run the reader may
 * see (see the module comment), and every visible repository's sync state.
 */
export async function getSyncStatus(
  db: Db,
  args: SyncStatusArgs = {},
  options: QueryOptions = {},
): Promise<SyncStatus> {
  const limit = statusLimit(args.limit);

  const runColumns = {
    id: syncRuns.id,
    trigger: syncRuns.trigger,
    scope: syncRuns.scope,
    status: syncRuns.status,
    startedAt: syncRuns.startedAt,
    finishedAt: syncRuns.finishedAt,
    error: syncRuns.error,
  };
  const [last] = await db
    .select(runColumns)
    .from(syncRuns)
    .where(and(ne(syncRuns.status, "running"), visibleRun(options)))
    .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
    .limit(1);
  const [running] = await db
    .select(runColumns)
    .from(syncRuns)
    .where(and(eq(syncRuns.status, "running"), visibleRun(options)))
    .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
    .limit(1);

  let lastRun: SyncRunSummary | null = null;
  if (last !== undefined) {
    const finishedAt = date(last.finishedAt);
    const startedAt = date(last.startedAt) ?? new Date(0);
    lastRun = {
      trigger: trigger(last.trigger),
      scope: clip(last.scope),
      status: last.status === "running" ? "failed" : last.status,
      startedAt,
      finishedAt,
      durationMs:
        finishedAt === null ? null : Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      error: clip(last.error),
      counts: await runCounts(db, last.id, options),
    };
  }

  const rows = await db
    .select({
      owner: repos.owner,
      name: repos.name,
      visibility: repos.visibility,
      syncStatus: repos.syncStatus,
      syncError: repos.syncError,
      lastSyncedAt: repos.lastSyncedAt,
      syncWarnings: repos.syncWarnings,
    })
    .from(repos)
    .where(visibleRepos(options))
    .orderBy(
      sql`lower(${repos.owner}) collate "C"`,
      sql`lower(${repos.name}) collate "C"`,
      sql`${repos.owner} collate "C"`,
      sql`${repos.name} collate "C"`,
      asc(repos.id),
    )
    .limit(limit + 1);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) filter (where ${repos.syncStatus} = 'ok')::int`,
      error: sql<number>`count(*) filter (where ${repos.syncStatus} = 'error')::int`,
      pending: sql<number>`count(*) filter (where ${repos.syncStatus} = 'pending')::int`,
      warned: sql<number>`count(*) filter (where jsonb_typeof(${repos.syncWarnings}) = 'array' and jsonb_array_length(${repos.syncWarnings}) > 0)::int`,
    })
    .from(repos)
    .where(visibleRepos(options));

  const listed = rows.slice(0, limit).map((row): RepoSyncState => {
    const warnings = parseSyncWarnings(row.syncWarnings);
    return {
      owner: row.owner,
      name: row.name,
      visibility: row.visibility,
      syncStatus: row.syncStatus,
      syncError: clip(row.syncError),
      lastSyncedAt: row.lastSyncedAt,
      warnings: warnings.map((w) => ({ code: w.code, message: w.message, count: w.count })),
      skippedFiles: warnings.reduce((sum, w) => sum + w.count, 0),
    };
  });

  return {
    lastRun,
    running:
      running === undefined
        ? null
        : {
            trigger: trigger(running.trigger),
            scope: clip(running.scope),
            startedAt: date(running.startedAt) ?? new Date(0),
          },
    repos: listed,
    reposTotal: int(totals?.total),
    reposByStatus: {
      ok: int(totals?.ok),
      error: int(totals?.error),
      pending: int(totals?.pending),
    },
    reposWithWarnings: int(totals?.warned),
    truncated: rows.length > limit,
  };
}

/**
 * The latest finished run that recorded this visible repository (searched over the last
 * `REPO_RUN_LOOKBACK` finished runs), with the repository's own outcome in it; null when the
 * repository is hidden or unknown, `{ lastRun: null }` when no recent run mentions it.
 */
export async function getRepoSyncInfo(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<{ readonly lastRun: RepoLastRun | null } | null> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return null;
  const [row] = await db
    .select({ githubId: repos.githubId })
    .from(repos)
    .where(and(visibleRepos(options), where))
    .limit(1);
  if (row === undefined) return null;

  const result = await db.execute(sql`
    select r.trigger as "trigger", r.scope is null as "full_run",
      r.started_at as "started_at", r.finished_at as "finished_at", e.value as "entry"
    from (
      select ${syncRuns.id} as id, ${syncRuns.trigger} as trigger, ${syncRuns.scope} as scope,
        ${syncRuns.startedAt} as started_at, ${syncRuns.finishedAt} as finished_at,
        ${syncRuns.results} as results
      from ${syncRuns}
      where ${syncRuns.status} <> 'running'
      order by ${syncRuns.startedAt} desc, ${syncRuns.id} desc
      limit ${REPO_RUN_LOOKBACK}
    ) as r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.results) = 'array' then r.results else '[]'::jsonb end
    ) as e(value)
    where e.value->'githubId' = to_jsonb(${row.githubId}::bigint)
      and e.value->>'status' in ('ok', 'unchanged', 'error', 'skipped')
    order by r.started_at desc, r.id desc
    limit 1
  `);
  const found = result.rows[0];
  if (found === undefined) return { lastRun: null };
  const entry = (found.entry ?? {}) as Record<string, unknown>;
  const outcome =
    typeof entry.status === "string" && OUTCOMES.has(entry.status) ? entry.status : "error";
  const error = typeof entry.error === "string" && entry.error !== "" ? clip(entry.error) : null;
  return {
    lastRun: {
      trigger: trigger(found.trigger),
      fullRun: found.full_run === true,
      startedAt: date(found.started_at) ?? new Date(0),
      finishedAt: date(found.finished_at),
      outcome: outcome as RepoLastRun["outcome"],
      error: outcome === "error" || outcome === "skipped" ? error : null,
      added: int(entry.added),
      updated: int(entry.updated),
      removed: int(entry.removed),
      skipped: int(entry.skipped),
      warnings: int(entry.warningsTotal),
    },
  };
}
