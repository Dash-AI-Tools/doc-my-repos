import { and, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { repos } from "../db/schema";
import { visibleRepos, type QueryOptions } from "./visibility";

/** What the asset proxy needs to know about a repository. */
export interface AssetRepo {
  readonly githubId: number;
  /** Canonical spelling, as stored by the sync. */
  readonly owner: string;
  readonly name: string;
  /** Empty for an empty repository (nothing to serve). */
  readonly defaultBranch: string;
  readonly visibility: "public" | "private";
}

/**
 * The synced repository `owner/name` as the current reader may see it, or null. Goes through
 * the shared visibility filter (`visibleRepos`), so a repository the filter hides cannot serve
 * assets either.
 *
 * Matching ignores case, as GitHub does (`ACME/Handbook` is `acme/handbook`). Stored owner/name
 * are case-sensitive text, so two rows may differ only by case for a moment after a rename; the
 * exact spelling then wins, and two case-variants with no exact match answer null. The repos
 * table is small (one row per repository), so `lower()` without an index is fine.
 */
export async function findAssetRepo(
  db: Db,
  owner: string,
  name: string,
  options: QueryOptions = {},
): Promise<AssetRepo | null> {
  const exact = sql<boolean>`(${repos.owner} = ${owner} and ${repos.name} = ${name})`;
  const rows = await db
    .select({
      githubId: repos.githubId,
      owner: repos.owner,
      name: repos.name,
      defaultBranch: repos.defaultBranch,
      visibility: repos.visibility,
      exact,
    })
    .from(repos)
    .where(
      and(
        visibleRepos(options),
        sql`lower(${repos.owner}) = lower(${owner})`,
        sql`lower(${repos.name}) = lower(${name})`,
      ),
    )
    .orderBy(sql`${exact} desc`, repos.id)
    .limit(2);

  const [first, second] = rows;
  if (first === undefined) return null;
  if (!first.exact && second !== undefined) return null;
  return {
    githubId: first.githubId,
    owner: first.owner,
    name: first.name,
    defaultBranch: first.defaultBranch,
    visibility: first.visibility,
  };
}
