/**
 * The state of the `/search` page and its URL (task 10.3, search spec "Shareable URL"). Pure: no
 * React, no database, safe for server and client code, and the single place that turns query
 * parameters into a state and a state back into a URL, so a link, a form and the command palette
 * (10.4) cannot disagree about what a search URL looks like.
 *
 * URL grammar (all optional):
 *
 *   /search?q=<text>&repo=<owner/name>&type=<value>&tag=<value>&status=<value>&page=<n>&limit=<n>
 *
 * - `repo`, `type`, `tag` and `status` may repeat; values of one kind are OR-ed, kinds are AND-ed
 *   (the query layer's rule). `type`, `tag` and `status` are matched exactly as authored: no case
 *   folding, no trimming (OKF `type` is free-form). `repo` is `owner/name`, case-insensitive.
 *   The same grammar can carry the type/tag/status filters of the repository table of contents
 *   (task 11.x): `buildFilterQuery` produces just the filter part.
 * - `page` is 1-based, `limit` is the page size (1 to 100, default 20). Neither is written when it
 *   has its default value.
 *
 * Reading is forgiving, writing is canonical. `parseSearchParams` never throws and never returns
 * a value the query layer would reject: control characters and over-long text are cleaned with
 * the same normalizers the query layer uses, and filter values that can match no stored value
 * (empty, too long, containing NUL) are dropped rather than kept as a filter that matches
 * nothing. `buildSearchUrl` always writes the same URL for the same state: keys in alphabetical
 * order, values of a repeated key sorted and de-duplicated, defaults omitted, every value
 * percent-encoded (spaces as `%20`, `/` as `%2F`). `parseSearchParams(buildSearchUrl(s))` equals
 * `s` for any state `parseSearchParams` can produce.
 */

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_FILTER_VALUES,
  MAX_SEARCH_OFFSET,
  normalizeFilterValues,
  normalizeRepoFilter,
  normalizeSearchQuery,
  searchLimit,
} from "./search";

export const SEARCH_PATH = "/search";

/** The four filter kinds. The value is also the URL parameter name. */
export type FilterKind = "repo" | "type" | "tag" | "status";

export const FILTER_KINDS: readonly FilterKind[] = ["repo", "type", "tag", "status"];

export interface SearchState {
  /** Normalized query text; empty means "no search yet". */
  readonly q: string;
  /** `owner/name`, as given (the first spelling wins; compared case-insensitively). */
  readonly repos: readonly string[];
  readonly types: readonly string[];
  readonly tags: readonly string[];
  readonly statuses: readonly string[];
  /** 1-based. */
  readonly page: number;
  /** Results per page, 1 to 100. */
  readonly limit: number;
}

export const EMPTY_SEARCH_STATE: SearchState = {
  q: "",
  repos: [],
  types: [],
  tags: [],
  statuses: [],
  page: 1,
  limit: DEFAULT_SEARCH_LIMIT,
};

/** What Next.js hands a page as `searchParams`, or a `URLSearchParams` (the palette's API). */
export type RawSearchParams =
  Readonly<Record<string, string | readonly string[] | undefined>> | URLSearchParams;

/** Highest page number read from a URL; a larger one is clamped (and is empty anyway). */
export const MAX_PAGE = 100_000;

const DIGITS = /^[0-9]{1,6}$/;

/** Every value of `key`, in order. Own properties only, so `__proto__` and friends are inert. */
function valuesOf(raw: RawSearchParams, key: string): string[] {
  if (raw instanceof URLSearchParams) return raw.getAll(key);
  if (!Object.hasOwn(raw, key)) return [];
  const value = raw[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return (value as unknown[]).filter((v): v is string => typeof v === "string");
  return [];
}

function parsePositive(values: readonly string[]): number | null {
  const first = values[0];
  if (first === undefined || !DIGITS.test(first)) return null;
  return Number(first);
}

function repoValues(values: readonly string[]): string[] {
  const parsed = normalizeRepoFilter(values) ?? [];
  const out: string[] = [];
  for (const ref of parsed) {
    // Row ids are an API convenience of the query layer; a URL names a repository.
    if ("owner" in ref) out.push(`${ref.owner}/${ref.name}`);
  }
  return out.slice(0, MAX_FILTER_VALUES);
}

function sortedUnique(values: readonly string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  // Code unit order: stable and locale-independent.
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_FILTER_VALUES);
}

/** Parses a search URL's parameters into a state. Never throws. Filter lists come back sorted. */
export function parseSearchParams(raw: RawSearchParams): SearchState {
  const page = parsePositive(valuesOf(raw, "page"));
  const limit = parsePositive(valuesOf(raw, "limit"));
  return {
    q: normalizeSearchQuery(valuesOf(raw, "q")[0]),
    repos: sortedUnique(repoValues(valuesOf(raw, "repo")), true),
    types: sortedUnique(normalizeFilterValues(valuesOf(raw, "type")) ?? [], false),
    tags: sortedUnique(normalizeFilterValues(valuesOf(raw, "tag")) ?? [], false),
    statuses: sortedUnique(normalizeFilterValues(valuesOf(raw, "status")) ?? [], false),
    page: page === null || page < 1 ? 1 : Math.min(page, MAX_PAGE),
    limit: limit === null ? DEFAULT_SEARCH_LIMIT : searchLimit(limit),
  };
}

/** `encodeURIComponent`, plus the characters it leaves bare that are awkward in a URL or a log. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function pairs(key: string, values: readonly string[]): string[] {
  return values.map((value) => `${key}=${encode(value)}`);
}

/**
 * The filter part of a URL (`repo=..&status=..&tag=..&type=..`), canonical, without a leading
 * `?`. Empty when no filter is set. Shared with the repository table of contents (task 11.x).
 */
export function buildFilterQuery(
  filters: Pick<SearchState, "repos" | "types" | "tags" | "statuses">,
): string {
  return [
    ...pairs("repo", sortedUnique(filters.repos, true)),
    ...pairs("status", sortedUnique(filters.statuses, false)),
    ...pairs("tag", sortedUnique(filters.tags, false)),
    ...pairs("type", sortedUnique(filters.types, false)),
  ].join("&");
}

/** The canonical root-relative URL for a state: `/search` plus a sorted query, defaults omitted. */
export function buildSearchUrl(state: Partial<SearchState> = {}): string {
  const q = normalizeSearchQuery(state.q ?? "");
  const page =
    state.page === undefined || !Number.isSafeInteger(state.page) || state.page < 1
      ? 1
      : Math.min(state.page, MAX_PAGE);
  const limit = searchLimit(state.limit);
  const parts = [
    ...(limit === DEFAULT_SEARCH_LIMIT ? [] : [`limit=${limit}`]),
    ...(page === 1 ? [] : [`page=${page}`]),
    ...(q === "" ? [] : [`q=${encode(q)}`]),
    buildFilterQuery({
      repos: state.repos ?? [],
      types: state.types ?? [],
      tags: state.tags ?? [],
      statuses: state.statuses ?? [],
    }),
  ].filter((part) => part !== "");
  // The filter group is already in key order (repo, status, tag, type) and sorts after q.
  return parts.length === 0 ? SEARCH_PATH : `${SEARCH_PATH}?${parts.join("&")}`;
}

const LIST_KEY = {
  repo: "repos",
  type: "types",
  tag: "tags",
  status: "statuses",
} as const;

/** The selected values of one filter kind. */
export function filterValues(state: SearchState, kind: FilterKind): readonly string[] {
  return state[LIST_KEY[kind]];
}

function same(kind: FilterKind, a: string, b: string): boolean {
  return kind === "repo" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isFilterSelected(state: SearchState, kind: FilterKind, value: string): boolean {
  return filterValues(state, kind).some((v) => same(kind, v, value));
}

/** The state with `value` added to (or, when already selected, removed from) a filter kind. Back to page 1. */
export function toggleFilter(state: SearchState, kind: FilterKind, value: string): SearchState {
  const current = filterValues(state, kind);
  const next = isFilterSelected(state, kind, value)
    ? current.filter((v) => !same(kind, v, value))
    : [...current, value].slice(0, MAX_FILTER_VALUES);
  return { ...state, [LIST_KEY[kind]]: next, page: 1 };
}

export function filterCount(state: SearchState): number {
  return state.repos.length + state.types.length + state.tags.length + state.statuses.length;
}

export function hasFilters(state: SearchState): boolean {
  return filterCount(state) > 0;
}

/** The state without any filter (query and page size kept), back to page 1. */
export function clearFilters(state: SearchState): SearchState {
  return { ...state, repos: [], types: [], tags: [], statuses: [], page: 1 };
}

/**
 * A new query keeps the filters and the page size but starts at page 1 (the old page number means
 * nothing for different results). The search form posts the same fields as hidden inputs.
 */
export function withQuery(state: SearchState, q: string): SearchState {
  return { ...state, q: normalizeSearchQuery(q), page: 1 };
}

/**
 * The fields a new search keeps as hidden inputs of the search form: the filters and a
 * non-default page size, but not `q` (the visible field) and not `page`.
 */
export function formFields(state: SearchState): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  for (const kind of FILTER_KINDS) {
    for (const value of filterValues(state, kind)) fields.push({ name: kind, value });
  }
  if (state.limit !== DEFAULT_SEARCH_LIMIT)
    fields.push({ name: "limit", value: String(state.limit) });
  return fields;
}

export function withPage(state: SearchState, page: number): SearchState {
  return { ...state, page };
}

/** Results to skip for the state's page. */
export function offsetFor(state: SearchState): number {
  return (state.page - 1) * state.limit;
}

/** Paging figures for a result page, from the total match count and the hits on the page. */
export interface Paging {
  readonly page: number;
  /** 1-based number of the first and last result shown; 0 when the page is empty. */
  readonly from: number;
  readonly to: number;
  readonly total: number;
  /** Last page that can be shown (the query layer serves offsets up to `MAX_SEARCH_OFFSET`). */
  readonly lastPage: number;
  readonly prevPage: number | null;
  readonly nextPage: number | null;
  /** More matches exist than the pages that can be browsed. */
  readonly capped: boolean;
  /** The requested page is past the last page that has results. */
  readonly outOfRange: boolean;
}

export function computePaging(state: SearchState, total: number, shown: number): Paging {
  const offset = offsetFor(state);
  const lastBrowsable = Math.floor(MAX_SEARCH_OFFSET / state.limit) + 1;
  const pages = Math.ceil(total / state.limit);
  const lastPage = Math.max(1, Math.min(pages, lastBrowsable));
  const outOfRange = shown === 0 && total > 0;
  return {
    page: state.page,
    from: shown === 0 ? 0 : offset + 1,
    to: shown === 0 ? 0 : offset + shown,
    total,
    lastPage,
    prevPage: state.page > 1 ? Math.min(state.page - 1, lastPage) : null,
    nextPage: !outOfRange && state.page < lastPage ? state.page + 1 : null,
    capped: pages > lastBrowsable,
    outOfRange,
  };
}
