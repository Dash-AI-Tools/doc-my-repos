import { and, eq, ne } from "drizzle-orm";

import type { Db } from "../db/client";
import { repos } from "../db/schema";
import { INSTALLATION_UNAVAILABLE_MESSAGES, type InstallationUnavailableReason } from "./router";

/**
 * The two immediate writes the webhook router awaits (task 6.3). Each is one UPDATE statement,
 * takes no repo lock (it must not wait behind a running sync) and leaves `updated_at` alone,
 * which marks content writes by a sync (the removal guard compares it with the listing time).
 */

/**
 * `repository` `privatized`: makes the stored row private at once (fail closed), before the
 * follow-up sync confirms it. Returns whether a row changed. A concurrent sync that listed the
 * repository before the change may still write `public`; the follow-up sync corrects it.
 */
export async function markRepoPrivate(db: Db, githubId: number): Promise<boolean> {
  const rows = await db
    .update(repos)
    .set({ visibility: "private" })
    .where(and(eq(repos.githubId, githubId), ne(repos.visibility, "private")))
    .returning({ id: repos.id });
  return rows.length > 0;
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
