import { asc, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { repoFolders } from "../db/schema";

/** A folder (repo-folders). Carries no repository data; the home page shows one only when a visible repository is in it. */
export interface FolderSummary {
  readonly id: number;
  readonly name: string;
  /** Plain text; null when not set. */
  readonly description: string | null;
  /** Place in the admin-set tab order; null when not starred. */
  readonly starPosition: number | null;
  readonly isStarred: boolean;
  /** Every allowed repository in it is readable without signing in (public access). */
  readonly isPublic: boolean;
}

/**
 * Every folder, starred first by place then id, then the rest by name (case-insensitive, byte
 * order) then id. Folders hold no repository data, so there is no visibility filter here: callers
 * decide what to show from the (filtered) repositories that point at a folder. A reader who is not
 * signed in passes `publicOnly`: a folder that is not public is never listed to them, not even by name.
 */
export async function listFolders(
  db: Db,
  options: { readonly publicOnly?: boolean } = {},
): Promise<FolderSummary[]> {
  const rows = await db
    .select({
      id: repoFolders.id,
      name: repoFolders.name,
      description: repoFolders.description,
      starPosition: repoFolders.starPosition,
      isPublic: repoFolders.isPublic,
    })
    .from(repoFolders)
    .where(options.publicOnly === true ? eq(repoFolders.isPublic, true) : sql`true`)
    .orderBy(
      sql`${repoFolders.starPosition} asc nulls last`,
      sql`lower(${repoFolders.name}) collate "C"`,
      asc(repoFolders.id),
    );
  return rows.map((r) => ({ ...r, isStarred: r.starPosition !== null }));
}
