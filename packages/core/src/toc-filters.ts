/**
 * Type, tag and status filters of a repository's table of contents (task 11.2 and 11.3, OKF spec
 * "Filter by type"). Pure: no React, no database, safe for server and client code.
 *
 * The filters live in the URL of the page the visitor is reading (the repository page or a
 * document page), with the grammar of `/search` (`packages/core/src/search-params.ts`): `type=`, `tag=` and
 * `status=`, each repeatable, values of one kind OR-ed, kinds AND-ed, matched exactly as authored
 * (case-sensitive, no merging of `Metric` and `metric`). The state is a `SearchState` with the
 * query, the repository filter and the page left at their defaults, so the search helpers
 * (`toggleFilter`, `isFilterSelected`, `buildFacetGroups`) work unchanged.
 *
 * Decisions:
 * - A row matches when it is not a reserved file (`index.md`, `log.md`: never typed concepts) and
 *   passes every filter kind that has values. A document without a `type` never matches a type
 *   filter; a document without tags never matches a tag filter.
 * - With no filter every row is kept, reserved files included: the tree is the plain tree.
 * - The sidebar of a document page keeps the document being read in the tree even when it does not
 *   match (`keepPath`), so the reader never loses their place; it is not counted as a match.
 * - Previous/next links of a document page ignore the filters: they follow the whole table of
 *   contents, as the spec says. The links of the filtered tree carry the filters, so they survive
 *   moving between documents.
 */

import type { DocsTreeRow } from "./docs-tree";
import {
  buildFilterQuery,
  buildFilterUrl,
  parseSearchParams,
  type RawSearchParams,
  type SearchState,
} from "./search-params";
import { buildFacetGroups, type FacetGroup } from "./search-view";

/** The URL state of the table of contents filters (a `SearchState` without query or repos). */
export type TocFilterState = SearchState;

export function parseTocFilters(raw: RawSearchParams): TocFilterState {
  const state = parseSearchParams(raw);
  return { ...state, q: "", repos: [], page: 1 };
}

export function hasTocFilters(state: TocFilterState): boolean {
  return state.types.length + state.tags.length + state.statuses.length > 0;
}

/** True when a document passes the filters. Reserved files never do. */
export function rowMatchesFilters(row: DocsTreeRow, state: TocFilterState): boolean {
  if (row.reserved !== null) return false;
  if (state.types.length > 0 && (row.type === null || !state.types.includes(row.type))) {
    return false;
  }
  if (state.tags.length > 0 && !row.tags.some((tag) => state.tags.includes(tag))) return false;
  if (state.statuses.length > 0 && (row.status === null || !state.statuses.includes(row.status))) {
    return false;
  }
  return true;
}

/**
 * The rows to build the tree from: all of them without a filter, else the matching ones plus the
 * row at `keepPath` (the page being read). Filter first, then `buildDocsTree`, so a folder with no
 * matching document is not in the tree at all.
 */
export function filterDocsRows<T extends DocsTreeRow>(
  rows: readonly T[],
  state: TocFilterState,
  keepPath: string | null = null,
): T[] {
  if (!hasTocFilters(state)) return [...rows];
  return rows.filter((row) => rowMatchesFilters(row, state) || row.path === keepPath);
}

export interface TocCounts {
  /** Documents that pass the filters. */
  readonly matches: number;
  /** Documents that could be shown with no filter: every row that is not a reserved file. */
  readonly total: number;
}

export function countTocRows(rows: readonly DocsTreeRow[], state: TocFilterState): TocCounts {
  const candidates = rows.filter((row) => row.reserved === null);
  return {
    matches: hasTocFilters(state)
      ? candidates.filter((row) => rowMatchesFilters(row, state)).length
      : candidates.length,
    total: candidates.length,
  };
}

/** Facet counts of the table of contents, as `getRepoFacets` returns them. */
export interface TocFacetCounts {
  readonly types: readonly { readonly value: string; readonly count: number }[];
  readonly tags: readonly { readonly value: string; readonly count: number }[];
  readonly statuses: readonly { readonly value: string; readonly count: number }[];
}

/** What the filter controls render. Built by `buildTocFilterView`. */
export interface TocFilterView {
  /** Type, Tag, Status (in that order), only those with something to show. */
  readonly groups: readonly FacetGroup[];
  /** At least one filter is selected. */
  readonly active: boolean;
  /** The page's URL with every filter removed. */
  readonly clearHref: string;
  /** The canonical filter query (no `?`), appended to the links of the tree. */
  readonly query: string;
  readonly matches: number;
  readonly total: number;
}

/**
 * The view of the filter controls, or null when there is nothing to show: no value to filter by
 * and no filter selected (a repository whose documents have no type, tag or status). Counts are
 * disjunctive: each group is counted with the other kinds' filters applied, not its own.
 */
export function buildTocFilterView(args: {
  /** Root-relative path of the page the links point to (no query). */
  readonly basePath: string;
  readonly state: TocFilterState;
  readonly facets: TocFacetCounts;
  readonly counts: TocCounts;
}): TocFilterView | null {
  const { basePath, state, facets, counts } = args;
  const groups = buildFacetGroups(
    state,
    { repos: [], types: facets.types, tags: facets.tags, statuses: facets.statuses },
    { href: (next) => buildFilterUrl(basePath, next), selectedFirst: false },
  );
  const active = hasTocFilters(state);
  if (groups.length === 0 && !active) return null;
  return {
    groups,
    active,
    clearHref: basePath,
    query: buildFilterQuery(state),
    matches: counts.matches,
    total: counts.total,
  };
}

/** `href` with the filter query appended; unchanged without a filter. */
export function withFilterQuery(href: string, query: string): string {
  return query === "" ? href : `${href}?${query}`;
}

/** What a page loads for the filter controls of an OKF repository (null for a plain one). */
export interface TocData {
  /** The filters in effect, from the URL. */
  readonly state: TocFilterState;
  readonly facets: TocFacetCounts;
  readonly counts: TocCounts;
}
