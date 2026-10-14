/**
 * View models of the `/search` page (task 10.3): what the presentational components render, and the
 * pure functions that build the facet panel from the facet counts. No React, no database, no
 * server-only code, so components, the page loader (`src/server/search-page.ts`) and tests share
 * them. The command palette (10.4) can reuse `ResultItemData`.
 */

import {
  buildSearchUrl,
  clearFilters,
  filterValues,
  FILTER_KINDS,
  isFilterSelected,
  toggleFilter,
  type FilterKind,
  type Paging,
  type SearchState,
} from "./search-params";

/** One search result, ready to render. Every string is plain text (React escapes it). */
export interface ResultItemData {
  /** Stable key: repository id and document path. */
  readonly key: string;
  readonly title: string;
  /** In-app link to the document, with the best matching heading as `#anchor` when there is one. */
  readonly href: string;
  /** `owner/name`. */
  readonly repoLabel: string;
  readonly repoHref: string;
  /** Repo-relative path of the document. */
  readonly path: string;
  /** Section the snippet comes from (the best matching heading below the title), or null. */
  readonly section: string | null;
  /** Plain text with highlight markers; render with `splitHighlights`. May be empty. */
  readonly snippet: string;
  readonly isPrivate: boolean;
  readonly type: string | null;
  readonly status: string | null;
  readonly tags: readonly string[];
}

/** Raw facet counts, as the query layer returns them (structural copy, no server import). */
export interface FacetCounts {
  readonly repos: readonly {
    readonly owner: string;
    readonly name: string;
    readonly count: number;
  }[];
  readonly types: readonly { readonly value: string; readonly count: number }[];
  readonly tags: readonly { readonly value: string; readonly count: number }[];
  readonly statuses: readonly { readonly value: string; readonly count: number }[];
}

export interface FacetOption {
  /** The value as it appears in the URL (`owner/name` for a repository). */
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  /** The URL with this value toggled: adds it, or removes it when it is already selected. */
  readonly href: string;
}

export interface FacetGroup {
  readonly kind: FilterKind;
  readonly label: string;
  /** Selected options first, then the others by count (the order the facets arrive in). */
  readonly options: readonly FacetOption[];
}

export interface ActiveFilter {
  readonly kind: FilterKind;
  readonly kindLabel: string;
  readonly value: string;
  /** The URL without this filter. */
  readonly removeHref: string;
}

export const FACET_LABELS: Readonly<Record<FilterKind, string>> = {
  repo: "Repository",
  type: "Type",
  tag: "Tag",
  status: "Status",
};

/**
 * How a state becomes a link. The search page uses `buildSearchUrl`; the table of contents of a
 * repository (task 11.2) uses `buildFilterUrl` with its own page as the base path, so the same
 * facet options link to the page they are shown on.
 */
export type HrefForState = (state: SearchState) => string;

export interface FacetGroupOptions {
  /** Default `buildSearchUrl` (the `/search` page). */
  readonly href?: HrefForState;
  /**
   * Selected options first (default, the search panel). `false` keeps the order the counts arrive
   * in (count, then value), so chips do not jump when one is selected; selected values with no
   * count are still listed, after the counted ones.
   */
  readonly selectedFirst?: boolean;
}

function optionsFor(
  state: SearchState,
  kind: FilterKind,
  counted: readonly { value: string; label: string; count: number }[],
  hrefFor: HrefForState,
  selectedFirst: boolean,
): FacetOption[] {
  const options: FacetOption[] = counted.map((c) => ({
    value: c.value,
    label: c.label,
    count: c.count,
    selected: isFilterSelected(state, kind, c.value),
    href: hrefFor(toggleFilter(state, kind, c.value)),
  }));
  // A selected value that is not counted matches nothing under the other filters (or fell off the
  // end of the top-N list): still shown, so it can be removed.
  for (const value of filterValues(state, kind)) {
    if (!options.some((o) => sameValue(kind, o.value, value))) {
      options.push({
        value,
        label: value,
        count: 0,
        selected: true,
        href: hrefFor(toggleFilter(state, kind, value)),
      });
    }
  }
  if (!selectedFirst) return options;
  return [...options.filter((o) => o.selected), ...options.filter((o) => !o.selected)];
}

function sameValue(kind: FilterKind, a: string, b: string): boolean {
  return kind === "repo" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The facet groups to show, in the order Repository, Type, Tag, Status. A group is left out when it
 * has nothing to offer: no counted value and nothing selected. That hides the OKF groups (type,
 * tag, status) for results without such values, so non-OKF repositories show no OKF controls.
 */
export function buildFacetGroups(
  state: SearchState,
  facets: FacetCounts,
  groupOptions: FacetGroupOptions = {},
): FacetGroup[] {
  const hrefFor = groupOptions.href ?? buildSearchUrl;
  const selectedFirst = groupOptions.selectedFirst ?? true;
  const byKind: Record<FilterKind, FacetOption[]> = {
    repo: optionsFor(
      state,
      "repo",
      facets.repos.map((r) => ({
        value: `${r.owner}/${r.name}`,
        label: `${r.owner}/${r.name}`,
        count: r.count,
      })),
      hrefFor,
      selectedFirst,
    ),
    type: optionsFor(
      state,
      "type",
      facets.types.map((t) => ({ ...t, label: t.value })),
      hrefFor,
      selectedFirst,
    ),
    tag: optionsFor(
      state,
      "tag",
      facets.tags.map((t) => ({ ...t, label: t.value })),
      hrefFor,
      selectedFirst,
    ),
    status: optionsFor(
      state,
      "status",
      facets.statuses.map((t) => ({ ...t, label: t.value })),
      hrefFor,
      selectedFirst,
    ),
  };
  return FILTER_KINDS.filter((kind) => byKind[kind].length > 0).map((kind) => ({
    kind,
    label: FACET_LABELS[kind],
    options: byKind[kind],
  }));
}

/** The selected filters, each with the URL that removes it. */
export function buildActiveFilters(
  state: SearchState,
  hrefFor: HrefForState = buildSearchUrl,
): ActiveFilter[] {
  return FILTER_KINDS.flatMap((kind) =>
    filterValues(state, kind).map((value) => ({
      kind,
      kindLabel: FACET_LABELS[kind],
      value,
      removeHref: hrefFor(toggleFilter(state, kind, value)),
    })),
  );
}

/** The URL with every filter removed (the query is kept). */
export function clearFiltersHref(
  state: SearchState,
  hrefFor: HrefForState = buildSearchUrl,
): string {
  return hrefFor(clearFilters(state));
}

/** How many options of a long facet list are shown before "Show more". Selected ones always are. */
export const FACET_VISIBLE = 6;

/** Splits a group's options into the always-visible ones and the ones behind "Show more". */
export function splitFacetOptions(
  options: readonly FacetOption[],
  visible: number = FACET_VISIBLE,
): { readonly shown: readonly FacetOption[]; readonly more: readonly FacetOption[] } {
  const selected = options.filter((o) => o.selected);
  const room = Math.max(0, visible - selected.length);
  const rest = options.filter((o) => !o.selected);
  return { shown: [...selected, ...rest.slice(0, room)], more: rest.slice(room) };
}

/**
 * What the `/search` page shows (built by `loadSearchPage`):
 * - `idle`: no query yet (instructions);
 * - `ok`: a search ran (it may have no hits: the empty state, or a page past the end);
 * - `error`: the database could not be read or the server is misconfigured (fixed text).
 */
export type SearchPageView =
  | { readonly status: "idle"; readonly state: SearchState }
  | { readonly status: "error"; readonly state: SearchState }
  | {
      readonly status: "ok";
      readonly state: SearchState;
      /** The query actually searched (normalized), to echo back as text. */
      readonly query: string;
      readonly total: number;
      readonly hits: readonly ResultItemData[];
      readonly groups: readonly FacetGroup[];
      readonly active: readonly ActiveFilter[];
      readonly paging: Paging;
    };
