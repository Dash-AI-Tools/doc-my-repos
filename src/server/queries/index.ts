import { findAssetRepo } from "./assets";
import {
  countDocs,
  getAdjacentDocs,
  getDocPaths,
  getDocsTree,
  getDocumentByPath,
} from "./documents";
import { getRepo, listCodeOwners, listRepos } from "./repos";
import { getRepoFacets, searchDocuments, searchFacets } from "./search";

/**
 * The shared read layer (task 9.1, design decision 5b). Pages and route handlers import reads
 * from here (`@/server/queries`), never the tables in `src/server/db/schema.ts`; the static
 * guard `enforcement.test.ts` fails the build of any file outside the allow-listed server
 * modules that touches `repos`, `documents` or `code_owners` directly.
 *
 * Adding a query: write it in a module of this folder as `(db, ...args, options?: QueryOptions)`,
 * put `visibleRepos(options)` in the `WHERE` on `repos` (join `repos` for any other table), list
 * columns instead of selecting whole `documents` rows (never `search_vector` outside search), and
 * register it in `QUERY_FUNCTIONS` below. `queries.test.ts` fails when an exported function of
 * this folder is missing from the registry, and runs every registered query with the visibility
 * filter flipped, so a new query cannot skip the filter unnoticed.
 */
export const QUERY_FUNCTIONS = {
  listRepos,
  getRepo,
  listCodeOwners,
  getDocsTree,
  getDocumentByPath,
  getDocPaths,
  getAdjacentDocs,
  countDocs,
  findAssetRepo,
  searchDocuments,
  searchFacets,
  getRepoFacets,
} as const;

/** Registered queries that may read `documents.search_vector` (search only, design decision 2). */
export const SEARCH_VECTOR_READERS: ReadonlySet<keyof typeof QUERY_FUNCTIONS> = new Set([
  "searchDocuments",
  "searchFacets",
] as const);

/**
 * Exported functions of this folder that are not queries (they return no rows): the visibility
 * filters and the building blocks every query uses. Anything else exported must be registered.
 */
export const NOT_QUERIES: ReadonlySet<string> = new Set([
  // visibility.ts: the filter itself.
  "activeRepoVisibility",
  "allowAllRepos",
  "publicReposOnly",
  "visibleRepos",
  // repo-ref.ts: input checks and the shared repository condition (resolved through the filter).
  "isLookupText",
  "isRowId",
  "ownerNameMatch",
  "pickRepoMatch",
  "repoCondition",
]);

export { findAssetRepo, type AssetRepo } from "./assets";
export {
  countDocs,
  getAdjacentDocs,
  getDocPaths,
  getDocsTree,
  getDocumentByPath,
  type AdjacentDocs,
  type DocumentDetail,
} from "./documents";
export type { RepoRef } from "./repo-ref";
export {
  getRepo,
  listCodeOwners,
  listRepos,
  type CodeOwnerRule,
  type ListReposArgs,
  type RepoDetail,
  type RepoReadme,
  type RepoSummary,
  type RepoSyncStatus,
  type RepoVisibility,
} from "./repos";
export {
  getRepoFacets,
  MAX_FACET_VALUES,
  searchDocuments,
  searchFacets,
  type FacetCount,
  type RepoFacetCount,
  type RepoFacetFilters,
  type RepoFacets,
  type SearchFacets,
  type SearchHeading,
  type SearchHit,
  type SearchParams,
  type SearchResult,
} from "./search";
export type { QueryOptions } from "./visibility";
