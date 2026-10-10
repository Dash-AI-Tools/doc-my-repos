import { and, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { repos } from "../db/schema";
import { isLookupText, MAX_NAME_CHARS, ownerNameMatch, pickRepoMatch } from "./repo-ref";
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
 * Matching ignores case, as GitHub does (`ACME/Handbook` is `acme/handbook`); the exact spelling
 * wins and two case-variants with no exact match answer null (`ownerNameMatch`). Input that
 * cannot match a stored name (empty, NUL, over-long) answers null without a query.
 */
export async function findAssetRepo(
  db: Db,
  owner: string,
  name: string,
  options: QueryOptions = {},
): Promise<AssetRepo | null> {
  if (!isLookupText(owner, MAX_NAME_CHARS) || !isLookupText(name, MAX_NAME_CHARS)) return null;
  const match = ownerNameMatch(owner, name);
  const rows = await db
    .select({
      githubId: repos.githubId,
      owner: repos.owner,
      name: repos.name,
      defaultBranch: repos.defaultBranch,
      visibility: repos.visibility,
      exact: match.exact,
    })
    .from(repos)
    .where(and(visibleRepos(options), match.where))
    .orderBy(sql`${match.exact} desc`, repos.id)
    .limit(2);

  const first = pickRepoMatch(rows);
  if (first === null) return null;
  return {
    githubId: first.githubId,
    owner: first.owner,
    name: first.name,
    defaultBranch: first.defaultBranch,
    visibility: first.visibility,
  };
}
