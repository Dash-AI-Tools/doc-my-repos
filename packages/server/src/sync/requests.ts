import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { repos } from "../db/schema";

/**
 * The per-repository rerun marker (task 6.4): `repos.sync_requested_at`.
 *
 * A sync request that finds the repository busy must not be dropped: a push that lands after the
 * running sync fetched its tree would otherwise stay unsynced until some later trigger. So every
 * request first records itself here, in the database (it survives other processes and crashes),
 * and only then tries the repo lock. Whoever holds the lock covers the request:
 *
 * - A pass takes a database instant (`databaseInstant`) before it reads GitHub (before its
 *   listing), and when it has finished, clears the marker only if it is not newer than that
 *   instant (`clearSyncRequest`). A request that arrived during the pass is newer and survives.
 * - After a holder releases the lock it rechecks the marker (`isSyncRequested`) and runs again
 *   when it is still set. A requester whose try-lock failed had set the marker before that
 *   attempt, while the holder still held the lock, so the holder's recheck after unlocking sees it.
 * - A pass interrupted by an abort or a lost lock leaves the marker as it was, and so does a pass
 *   whose listing failed (it read nothing fresh from GitHub), a full sync stopped by a fatal error
 *   before it reached the repo, and a crashed process; the next request, full sync or drain
 *   (`listSyncRequests`) picks it up.
 * - A pass that kept a row private against its own `public` listing (`visibilityWrite`) sets the
 *   marker, so a fresh pass re-reads the visibility.
 *
 * Instants are kept as ISO text with microseconds, not JS `Date`s (milliseconds), so a
 * comparison with a stored `timestamptz` is exact.
 *
 * Only the repo lock (keyed on `github_id`) and this marker decide coalescing; `sync_runs.status`
 * and the run lock are never consulted. These are write-side helpers of the sync, not portal
 * reads, so they do not go through the read-side visibility filter.
 */

/** A database clock reading, ISO 8601 UTC with microseconds. */
export type DbInstant = string & { readonly __brand: "DbInstant" };

/** The database clock now (`now()`), with microsecond precision. */
export async function databaseInstant(db: Db): Promise<DbInstant> {
  const result = await db.execute<{ at: string }>(
    sql`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
  );
  const at = result.rows[0]?.at;
  if (typeof at !== "string") throw new Error("database clock unavailable");
  return at as DbInstant;
}

const instant = (at: DbInstant) => sql`${at}::timestamptz`;

/**
 * Records a sync request for the repository: sets the marker to the database's `now()`, never
 * moving it backwards (two concurrent requests keep the later time). Returns false when the
 * repository has no stored row yet (first sync), so no marker could be recorded.
 */
export async function markSyncRequested(db: Db, githubId: number): Promise<boolean> {
  const rows = await db
    .update(repos)
    .set({ syncRequestedAt: sql`greatest(${repos.syncRequestedAt}, now())` })
    .where(eq(repos.githubId, githubId))
    .returning({ id: repos.id });
  return rows.length > 0;
}

/**
 * Clears the marker if the request it records is covered by a pass that started reading GitHub
 * at `since` (marker <= since). A newer request is left for the rerun. Returns whether it cleared.
 */
export async function clearSyncRequest(
  db: Db,
  githubId: number,
  since: DbInstant,
): Promise<boolean> {
  const rows = await db
    .update(repos)
    .set({ syncRequestedAt: null })
    .where(and(eq(repos.githubId, githubId), lte(repos.syncRequestedAt, instant(since))))
    .returning({ id: repos.id });
  return rows.length > 0;
}

/** Whether a request for the repository is waiting (its marker is set). */
export async function isSyncRequested(db: Db, githubId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.githubId, githubId), isNotNull(repos.syncRequestedAt)));
  return row !== undefined;
}

/** GitHub ids of every repository with a waiting request, oldest request first. */
export async function listSyncRequests(db: Db): Promise<number[]> {
  const rows = await db
    .select({ githubId: repos.githubId })
    .from(repos)
    .where(isNotNull(repos.syncRequestedAt))
    .orderBy(asc(repos.syncRequestedAt), asc(repos.id));
  return rows.map((r) => r.githubId);
}

/**
 * Whether another sync wrote the repository after `since` (every persist sets `updated_at`, and so
 * does a `privatized` webhook, `markRepoPrivate`). A pass whose listing was taken at `since` then
 * holds older metadata than what is stored (for example a `public` visibility from before a
 * `privatized` event) and must not write it. Call under the repo lock.
 */
export async function writtenSince(db: Db, githubId: number, since: DbInstant): Promise<boolean> {
  return (await storedStateSince(db, githubId, since)) === "written";
}

/**
 * The repository's stored row as a pass whose listing was taken at `since` sees it, under the
 * repo lock: `missing` (no row), `written` (written after `since`, see `writtenSince`) or
 * `current`.
 */
export async function storedStateSince(
  db: Db,
  githubId: number,
  since: DbInstant,
): Promise<"missing" | "written" | "current"> {
  const [row] = await db
    .select({ written: sql<boolean>`${repos.updatedAt} > ${instant(since)}` })
    .from(repos)
    .where(eq(repos.githubId, githubId));
  if (row === undefined) return "missing";
  return row.written ? "written" : "current";
}

/**
 * GitHub ids of the stored repositories (all of them, or only `githubId`). A run reads this after
 * its start instant and before its listing: a repo stored then whose row is gone when the worker
 * reaches it was removed after the listing (a webhook removal), so the listing is stale for it and
 * must not recreate it (see the worker in `engine.ts`).
 */
export async function storedGithubIds(db: Db, githubId?: number): Promise<Set<number>> {
  const rows = await db
    .select({ githubId: repos.githubId })
    .from(repos)
    .where(githubId === undefined ? undefined : eq(repos.githubId, githubId));
  return new Set(rows.map((r) => r.githubId));
}

/**
 * The visibility write for repository metadata from a GitHub snapshot (a listing) taken after the
 * database instant `listedAt`, as `repos` SET columns (a plain UPDATE or an upsert's
 * `ON CONFLICT DO UPDATE`, where the column references read the stored row).
 *
 * Public never overwrites a newer private (task 6.4 review, fail closed): when the snapshot says
 * `public` but the stored row is `private` and was written after `listedAt` (a `privatized`
 * webhook bumps `updated_at`, as does a newer sync), the snapshot may predate the privatization,
 * so the row stays private and its rerun marker is set, so a fresh pass (whose listing is newer
 * than that write) re-reads the visibility from GitHub. A snapshot saying `private` is always
 * written. Holding private for a write that was itself stale costs only that extra pass.
 *
 * The caller tells whether private was held by comparing the visibility it returns with `mapped`.
 */
export function visibilityWrite(mapped: "public" | "private", listedAt: DbInstant) {
  if (mapped === "private") return { visibility: "private" as const };
  const held = sql`(${repos.visibility} = 'private' and ${repos.updatedAt} > ${instant(listedAt)})`;
  return {
    visibility: sql`case when ${held} then ${repos.visibility} else 'public' end`,
    syncRequestedAt: sql`case when ${held} then greatest(${repos.syncRequestedAt}, now()) else ${repos.syncRequestedAt} end`,
  };
}
