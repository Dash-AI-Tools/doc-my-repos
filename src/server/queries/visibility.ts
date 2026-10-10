import { eq, sql, type SQL } from "drizzle-orm";

import { repos } from "../db/schema";

/**
 * THE visibility filter (design decision 5, spec repo-space "Private repository indication and
 * visibility-aware queries", scenario "Single enforcement point").
 *
 * Every read of repositories, documents, search results, facet counts and assets goes through
 * the shared query layer in `src/server/queries/`, and every query there adds
 * `visibleRepos(options)` to its `WHERE` on the `repos` table (documents and code owners join
 * `repos` and apply it there). Nothing else decides what a visitor may see, so restricting
 * access later (per-viewer GitHub access) changes only this file. Do not query `repos`,
 * `documents` or `code_owners` for display outside this layer, and do not write a second filter.
 *
 * In the MVP every synced repository is visible to every visitor: the active filter is
 * `allowAllRepos`. Queries take the filter as an option only so tests can swap it (for example
 * `publicReposOnly`) and prove that every read honours it (task 9.1).
 *
 * Every query of the layer is registered in `QUERY_FUNCTIONS` (`index.ts`); `queries.test.ts`
 * runs each one with this filter flipped, and `enforcement.test.ts` statically forbids reading
 * the tables from anywhere else. Search and facets (10.x) join here the same way.
 */

/** A condition on the `repos` table that is true for the rows the current reader may see. */
export type RepoVisibilityFilter = (table: typeof repos) => SQL;

/** MVP: everything synced is visible. */
export const allowAllRepos: RepoVisibilityFilter = () => sql`true`;

/** Hides private repositories. Not used in the MVP; tests use it to flip the filter. */
export const publicReposOnly: RepoVisibilityFilter = (table) => eq(table.visibility, "public");

/** The filter every read uses unless a test passes another. */
export const activeRepoVisibility: RepoVisibilityFilter = allowAllRepos;

/** Options every shared read accepts. */
export interface QueryOptions {
  /** Replaces the active filter. Tests only. */
  readonly visibility?: RepoVisibilityFilter;
}

/** The visibility condition for `repos`, to add to the `WHERE` of every read. */
export function visibleRepos(options: QueryOptions = {}): SQL {
  return (options.visibility ?? activeRepoVisibility)(repos);
}
