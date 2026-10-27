import { sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { repos } from "../db/schema";
import { INSTALLATION_UNAVAILABLE_MESSAGES, type InstallationUnavailableReason } from "./router";

/**
 * The two immediate writes the webhook router awaits (task 6.3). Each is one statement and takes
 * no repo lock (it must not wait behind a running sync).
 */

/**
 * `repository` `privatized`: makes the stored row private at once (fail closed), before the
 * follow-up sync confirms it. Returns whether the visibility changed (false when there is no row
 * or it was already private).
 *
 * It also moves `updated_at` forward (never back), even when the row was already private: the
 * event says "private as of now", so every GitHub listing taken before now is stale for this
 * repo's visibility. A sync whose listing predates this write then does not write its `public`
 * back: a full sync that reaches the repo later skips it (`writtenSince`), and one already inside
 * the repo keeps the row private and sets its rerun marker (`visibilityWrite` in persist and on
 * the error path). The cost: a full sync whose listing predates the event does not remove the
 * repo in that run (the removal guard sees a write after the listing); the next run re-plans it.
 */
export async function markRepoPrivate(db: Db, githubId: number): Promise<boolean> {
  // The CTE reads the old visibility under the row lock, so `changed` is exact.
  const result = await db.execute<{ changed: boolean }>(sql`
    with prior as (
      select ${repos.id} as id, ${repos.visibility} as visibility
      from ${repos} where ${repos.githubId} = ${githubId} for update
    )
    update ${repos}
    set visibility = 'private', updated_at = greatest(${repos.updatedAt}, now())
    from prior where ${repos.id} = prior.id
    returning prior.visibility <> 'private' as changed
  `);
  return result.rows[0]?.changed === true;
}

/**
 * `installation` `deleted` / `suspend`: marks every stored repo `error` with a fixed message that
 * records the reason. Documents, README, code owners and head state are untouched (content kept);
 * the next successful sync sets `ok` again. Returns the number of rows marked.
 */
export async function markInstallationUnavailable(
  db: Db,
  reason: InstallationUnavailableReason,
): Promise<number> {
  const rows = await db
    .update(repos)
    .set({ syncStatus: "error", syncError: INSTALLATION_UNAVAILABLE_MESSAGES[reason] })
    .returning({ id: repos.id });
  return rows.length;
}
