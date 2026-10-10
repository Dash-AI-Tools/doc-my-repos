import { and, eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { repos } from "../db/schema";
import { visibleRepos, type QueryOptions } from "./visibility";

/**
 * Shared building blocks of the query layer (task 9.1). Not queries themselves: every function
 * here either checks input or returns a SQL condition that the caller combines with
 * `visibleRepos(options)` in its own `WHERE`. `repoCondition` resolves an `owner/name` reference
 * through the visibility filter too, so a hidden repository resolves to nothing.
 */

/** A repository as callers name it: by its row id (from `getRepo`) or by `owner/name` from a URL. */
export type RepoRef = { readonly id: number } | { readonly owner: string; readonly name: string };

/** Longest owner or repository name looked up (GitHub allows 39 and 100). */
export const MAX_NAME_CHARS = 256;
/** Longest document path looked up. */
export const MAX_PATH_CHARS = 4096;
/** Most path candidates in one document lookup. */
export const MAX_PATH_CANDIDATES = 16;

const MAX_INT4 = 2_147_483_647;

/**
 * True when `value` can be sent as a lookup parameter: a non-empty string of at most `max`
 * characters with no NUL (Postgres text rejects NUL with an error). Anything else cannot match a
 * stored value, so lookups answer "not found" instead of sending it.
 */
export function isLookupText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\u0000")
  );
}

/** True for a value that can be a `repos.id` (a positive 4-byte integer). */
export function isRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4;
}

/**
 * Case-insensitive `owner/name` match, as GitHub does (`ACME/Handbook` is `acme/handbook`), plus
 * an `exact` flag to prefer the stored spelling. Stored owner/name are case-sensitive text, so two
 * rows can differ only by case for a moment after a rename: `pickRepoMatch` then takes the exact
 * spelling and refuses two case-variants with no exact match. The repos table is small (one row
 * per repository), so `lower()` without an index is fine.
 */
export function ownerNameMatch(owner: string, name: string): { where: SQL; exact: SQL<boolean> } {
  return {
    where: and(
      sql`lower(${repos.owner}) = lower(${owner})`,
      sql`lower(${repos.name}) = lower(${name})`,
    ) as SQL,
    exact: sql<boolean>`(${repos.owner} = ${owner} and ${repos.name} = ${name})`,
  };
}

/**
 * The row for an `ownerNameMatch` query run with `order by exact desc, id` and `limit 2`: the
 * first row when it is exact or alone, else null (ambiguous).
 */
export function pickRepoMatch<T extends { readonly exact: boolean }>(rows: readonly T[]): T | null {
  const [first, second] = rows;
  if (first === undefined) return null;
  if (!first.exact && second !== undefined) return null;
  return first;
}

/**
 * A condition on `repos` selecting the repository `ref` names, or null when it cannot name a
 * visible repository. An id needs no query (the caller's `WHERE` applies the visibility filter);
 * an `owner/name` is resolved here through the filter and the case rule above.
 */
export async function repoCondition(
  db: Db,
  ref: RepoRef,
  options: QueryOptions = {},
): Promise<SQL | null> {
  if ("id" in ref) return isRowId(ref.id) ? eq(repos.id, ref.id) : null;
  if (!isLookupText(ref.owner, MAX_NAME_CHARS) || !isLookupText(ref.name, MAX_NAME_CHARS)) {
    return null;
  }
  const match = ownerNameMatch(ref.owner, ref.name);
  const rows = await db
    .select({ id: repos.id, exact: match.exact })
    .from(repos)
    .where(and(visibleRepos(options), match.where))
    .orderBy(sql`${match.exact} desc`, repos.id)
    .limit(2);
  const picked = pickRepoMatch(rows);
  return picked === null ? null : eq(repos.id, picked.id);
}
