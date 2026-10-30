import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { repoFolders, repos } from "../db/schema";

/**
 * THE visibility filter (design decision 5, spec repo-space "Private repository indication and
 * visibility-aware queries", scenario "Single enforcement point").
 *
 * Every read of repositories, documents, search results, facet counts and assets goes through
 * the shared query layer in `packages/server/src/queries/`, and every query there adds
 * `visibleRepos(options)` to its `WHERE` on the `repos` table (documents and code owners join
 * `repos` and apply it there). Nothing else decides what a visitor may see, so restricting
 * access later (per-viewer GitHub access) changes only this file. Do not query `repos`,
 * `documents` or `code_owners` for display outside this layer, and do not write a second filter.
 *
 * In the MVP every synced repository is visible to every visitor: the active filter is
 * `allowAllRepos`. Queries take the filter as an option only so tests can swap it (for example
 * `githubPublicReposOnly`) and prove that every read honours it (task 9.1). With access-control the
 * active filter is `allowedReposOnly`; admins read the full list by passing `allowAllRepos`
 * explicitly from trusted server code (after `requireAdmin`).
 *
 * Every query of the layer is registered in `QUERY_FUNCTIONS` (`index.ts`); `queries.test.ts`
 * runs each one with this filter flipped, and `enforcement.test.ts` statically forbids reading
 * the tables from anywhere else. Search and facets (10.x) join here the same way.
 */

/** A condition on the `repos` table that is true for the rows the current reader may see. */
export type RepoVisibilityFilter = (table: typeof repos) => SQL;

/** MVP: everything synced is visible. Kept for tests and trusted admin reads. */
export const allowAllRepos: RepoVisibilityFilter = () => sql`true`;

/**
 * Hides the repositories that are private on GitHub (`repos.visibility`). Not used in production;
 * tests use it to flip the filter. Not the same as public access (`isPublic`), which is about who
 * may read without signing in.
 */
export const githubPublicReposOnly: RepoVisibilityFilter = (table) =>
  eq(table.visibility, "public");

/**
 * Access-control: only admin-allowed repositories are visible. This is the filter every read
 * uses. Blocked repos keep their stored content (re-allowing needs no re-sync) but disappear
 * from every query: grid, docs, search, facets, assets.
 */
export const allowedReposOnly: RepoVisibilityFilter = (table) => eq(table.isAllowed, true);

/**
 * Public access (public-access): what a reader who is not signed in may see. A repository is
 * visible when it is allowed and is public itself or sits in a public folder. A blocked repository
 * is hidden from everyone, public or not. Signed-in users keep `allowedReposOnly`.
 */
export const anonymousReposOnly: RepoVisibilityFilter = (table) =>
  and(
    eq(table.isAllowed, true),
    or(
      eq(table.isPublic, true),
      inArray(
        table.folderId,
        sql`(select ${repoFolders.id} from ${repoFolders} where ${repoFolders.isPublic} = true)`,
      ),
    ),
  ) as SQL;

/** Who is reading: a signed-in user (every allowed repository) or a visitor without a session. */
export type Reader = { readonly kind: "member" } | { readonly kind: "anonymous" };

export const MEMBER: Reader = Object.freeze({ kind: "member" });
export const ANONYMOUS: Reader = Object.freeze({ kind: "anonymous" });

/**
 * The visibility filter for a reader. Code that can serve an anonymous reader builds the reader
 * once per request and passes `{ visibility: filterFor(reader) }` to every shared query it calls;
 * `enforcement.test.ts` checks that it does.
 */
export function filterFor(reader: Reader): RepoVisibilityFilter {
  return reader.kind === "anonymous" ? anonymousReposOnly : activeRepoVisibility;
}

/** The filter every read uses unless a test passes another. */
export const activeRepoVisibility: RepoVisibilityFilter = allowedReposOnly;

/** Options every shared read accepts. */
export interface QueryOptions {
  /**
   * Replaces the active filter. Tests and trusted admin callers (server-side, after
   * `requireAdmin`) only; pages and public APIs never pass it.
   */
  readonly visibility?: RepoVisibilityFilter;
}

/** The visibility condition for `repos`, to add to the `WHERE` of every read. */
export function visibleRepos(options: QueryOptions = {}): SQL {
  return (options.visibility ?? activeRepoVisibility)(repos);
}
