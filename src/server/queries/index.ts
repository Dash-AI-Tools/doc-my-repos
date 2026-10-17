import { getApiSpec, listApiSpecs } from "./api-specs";
import { findAssetRepo } from "./assets";
import {
  countDocComments,
  getCommentDocument,
  getCommentStates,
  getCommentTarget,
  getCommentThread,
  listCommentsForModeration,
  listDocComments,
} from "./comments";
import {
  countDocs,
  findOkfGuidelines,
  getAdjacentDocs,
  getDocPaths,
  getDocsTree,
  getDocumentByPath,
  getRepoOutline,
} from "./documents";
import { getRepo, listCodeOwners, listRepoOverviews, listRepos } from "./repos";
import { getRepoFacets, searchDocuments, searchFacets } from "./search";
import { getRepoSyncInfo, getSyncStatus } from "./status";

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
  listRepoOverviews,
  getRepo,
  listCodeOwners,
  listApiSpecs,
  getApiSpec,
  getDocsTree,
  getDocumentByPath,
  getDocPaths,
  getAdjacentDocs,
  countDocs,
  getRepoOutline,
  findOkfGuidelines,
  findAssetRepo,
  searchDocuments,
  searchFacets,
  getRepoFacets,
  getSyncStatus,
  getRepoSyncInfo,
  listDocComments,
  countDocComments,
  getCommentDocument,
  getCommentTarget,
  getCommentThread,
  listCommentsForModeration,
  getCommentStates,
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
  "allowedReposOnly",
  "publicReposOnly",
  "visibleRepos",
  // repo-ref.ts: input checks and the shared repository condition (resolved through the filter).
  // comments.ts: checks a cursor string, returns no rows.
  "isCommentCursor",
  "isLookupText",
  "isRowId",
  "ownerNameMatch",
  "pickRepoMatch",
  "repoCondition",
]);

export { getApiSpec, listApiSpecs, type ApiSpecDetail, type ApiSpecSummary } from "./api-specs";
export { findAssetRepo, type AssetRepo } from "./assets";
export {
  COMMENT_STATES_MAX,
  COMMENTS_PAGE_SIZE,
  countDocComments,
  getCommentDocument,
  getCommentStates,
  getCommentTarget,
  getCommentThread,
  isCommentCursor,
  listCommentsForModeration,
  listDocComments,
  MODERATION_PAGE_MAX,
  type CommentDocument,
  type CommentSelector,
  type CommentStateRow,
  type CommentState,
  type CommentTarget,
  type CommentTargetOptions,
  type CommentThread,
  type CommentView,
  type DocCommentCounts,
  type DocCommentsPage,
  type ListCommentsForModerationArgs,
  type ListDocCommentsArgs,
  type ModerationComment,
  type ModerationPage,
} from "./comments";
export {
  countDocs,
  findOkfGuidelines,
  getAdjacentDocs,
  getDocPaths,
  getDocsTree,
  getDocumentByPath,
  getRepoOutline,
  MAX_OUTLINE_ROWS,
  type AdjacentDocs,
  type DocumentDetail,
  type GuidelinesDocument,
  type RepoOutline,
} from "./documents";
export type { RepoRef } from "./repo-ref";
export {
  getRepo,
  listCodeOwners,
  listRepoOverviews,
  listRepos,
  type CodeOwnerRule,
  type ListReposArgs,
  type RepoDetail,
  type RepoOverview,
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
export {
  getRepoSyncInfo,
  getSyncStatus,
  MAX_STATUS_REPOS,
  type RepoLastRun,
  type RepoSyncState,
  type RepoWarningSummary,
  type RunningSync,
  type SyncRunCounts,
  type SyncRunSummary,
  type SyncRunTrigger,
  type SyncStatus,
  type SyncStatusArgs,
} from "./status";
export type { QueryOptions } from "./visibility";
