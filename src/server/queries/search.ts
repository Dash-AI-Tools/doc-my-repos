import "server-only";

import { and, inArray, or, sql, type SQL } from "drizzle-orm";

import {
  cleanSnippet,
  HEADLINE_ANGLE,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  MAX_SEARCH_OFFSET,
  normalizeFilterValues,
  normalizeRepoFilter,
  normalizeSearchQuery,
  searchLimit,
  searchOffset,
} from "../../lib/search";
import type { Db } from "../db/client";
import { documents, repos, SEARCH_TEXT_CONFIG } from "../db/schema";
import type { RepoVisibility } from "./repos";
import { repoCondition, type RepoRef } from "./repo-ref";
import { visibleRepos, type QueryOptions } from "./visibility";

/**
 * Full-text search and facet counts (task 10.1, search spec, design decision 2).
 *
 * - The query text reaches Postgres only as a bound parameter of
 *   `websearch_to_tsquery(SEARCH_TEXT_CONFIG, $n)`; no tsquery string is ever built here. Text
 *   that yields no positive search term (empty, only punctuation or operators, or only negated
 *   terms such as `-draft`) returns no results, never every document.
 * - Ranking is `ts_rank` over the stored weighted `search_vector` (title A, headings B,
 *   description and tags C, body D) with `RANK_WEIGHTS`, chosen so one match in a higher field
 *   outranks any number of matches in a lower field for a one-word query (the spec's "Title
 *   outranks body"). No length normalization: it would let a short body-only document beat a long
 *   document whose title matches. Ties order by repository (case-insensitive, byte order) then
 *   path, so pages are stable.
 * - Snippets come from `ts_headline` with the private-use markers of `@/lib/search` around matched
 *   terms (no HTML), run only on the rows of the returned page, then go through `cleanSnippet`
 *   (task 10.2), which strips the Markdown and HTML out of the fragment and keeps only balanced
 *   markers: the snippet is plain text, rendered with `splitHighlights`.
 * - Filters: OR within a kind (any of the selected repos, types, tags, statuses), AND across
 *   kinds. Facet counts are disjunctive: each kind is counted over the matches narrowed by the
 *   other kinds' filters, not its own, so selecting a type still shows the other types' counts.
 * - Every read joins `repos` and applies `visibleRepos(options)`: hidden repositories appear in
 *   neither hits nor any count. These are the only queries that read `search_vector`.
 */

/**
 * `ts_rank` weights in Postgres order {D, C, B, A}: body, description/tags, headings, title. Each
 * step is more than the 1.645 (sum of 1/n²) ts_rank can reach from repeating a term in one
 * field, so a one-word match in a higher field always ranks above the lower field.
 */
export const RANK_WEIGHTS = [0.05, 0.15, 0.4, 1] as const;

/** Most values returned per facet kind, by count. */
export const MAX_FACET_VALUES = { repos: 200, types: 100, tags: 50, statuses: 50 } as const;

/**
 * `ts_headline` options: constant, built here, never from input. Markers are private-use code
 * points (see `HIGHLIGHT_START`), so a highlighted snippet carries no HTML. The fragment is cut
 * from raw Markdown, and `cleanSnippet` (task 10.2) then removes the syntax in it (URLs, table
 * rules, fence lines, attributes), which can be most of its words; hence the wider word range
 * than a plain-text snippet needs. `cleanSnippet` caps what is shown.
 */
const HEADLINE_OPTIONS = [
  `StartSel="${HIGHLIGHT_START}"`,
  `StopSel="${HIGHLIGHT_END}"`,
  "MaxFragments=2",
  "MaxWords=32",
  "MinWords=14",
  "ShortWord=2",
  'FragmentDelimiter=" … "',
].join(", ");

/** Body characters `ts_headline` looks at. Bounds its CPU on long documents. */
export const MAX_HEADLINE_SOURCE_CHARS = 100_000;

/** Search request. Arrays allow several values per filter; a single value may be given bare. */
export interface SearchParams {
  /** Query text, websearch syntax (`"exact phrase"`, `-exclude`, `or`). */
  readonly q: unknown;
  /** Repositories as `owner/name` (case-insensitive) or row id. */
  readonly repo?: unknown;
  /** OKF types, exact and case-sensitive. */
  readonly type?: unknown;
  /** Tags, exact. A document matches when it has any of them. */
  readonly tag?: unknown;
  /** Statuses, exact. */
  readonly status?: unknown;
  /** Results per page, 1 to 100 (default 20). */
  readonly limit?: unknown;
  /** Results to skip (default 0). Pages beyond `MAX_SEARCH_OFFSET` are empty. */
  readonly offset?: unknown;
}

/** The heading of a hit whose text matches the query best, for a `#anchor` deep link. */
export interface SearchHeading {
  readonly depth: number;
  readonly text: string;
  /** Stored slug; link with `anchorId(slug)` from `@/server/markdown/sanitize`. */
  readonly slug: string;
}

export interface SearchHit {
  readonly repo: {
    readonly id: number;
    readonly owner: string;
    readonly name: string;
    readonly visibility: RepoVisibility;
    /** For `docUrl(owner, name, doc.path, docsPath)`. */
    readonly docsPath: string | null;
  };
  readonly doc: {
    readonly path: string;
    readonly title: string;
    readonly description: string | null;
    readonly type: string | null;
    readonly tags: readonly string[];
    readonly status: string | null;
    readonly reserved: "index" | "log" | null;
  };
  readonly rank: number;
  /**
   * Plain text (no Markdown or HTML syntax, whitespace collapsed, at most `SNIPPET_MAX_CHARS`
   * characters) with matched terms between `HIGHLIGHT_START` and `HIGHLIGHT_END`, always in
   * balanced pairs; render with `splitHighlights`, never as HTML. From the body, else the
   * description, else the body start. May be empty when the document has no text.
   */
  readonly snippet: string;
  readonly heading: SearchHeading | null;
}

export interface SearchResult {
  /** The query actually searched (normalized), to echo back. */
  readonly query: string;
  readonly hits: readonly SearchHit[];
  /** Matches across all pages (with the filters). */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

export interface RepoFacetCount {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly count: number;
}

export interface SearchFacets {
  readonly query: string;
  /** Matches with every filter applied (equals `SearchResult.total`). */
  readonly total: number;
  /** Ordered by count, then owner/name. */
  readonly repos: readonly RepoFacetCount[];
  /** Non-null types as authored, by count then value. */
  readonly types: readonly FacetCount[];
  /** The `MAX_FACET_VALUES.tags` most frequent tags. */
  readonly tags: readonly FacetCount[];
  readonly statuses: readonly FacetCount[];
}

const searchConfig = sql.raw(`'${SEARCH_TEXT_CONFIG}'::regconfig`);

/** The normalized request: query text, filter conditions and paging. */
interface Prepared {
  readonly query: string;
  readonly tsQuery: SQL;
  readonly repoFilter: SQL;
  readonly typeFilter: SQL;
  readonly tagFilter: SQL;
  readonly statusFilter: SQL;
  readonly limit: number;
  readonly offset: number;
}

const TRUE = sql`true`;
const FALSE = sql`false`;

/** A text value list bound as one `text[]` parameter. */
function textArray(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

function valueFilter(values: readonly string[] | undefined, column: SQL): SQL {
  if (values === undefined) return TRUE;
  if (values.length === 0) return FALSE;
  return sql`${column} = any(${textArray(values)})`;
}

function repoFilter(value: unknown): SQL {
  const refs = normalizeRepoFilter(value);
  if (refs === undefined) return TRUE;
  const ids: number[] = [];
  const named: SQL[] = [];
  for (const ref of refs) {
    if ("id" in ref) ids.push(ref.id);
    else {
      named.push(
        and(
          sql`lower(${repos.owner}) = lower(${ref.owner})`,
          sql`lower(${repos.name}) = lower(${ref.name})`,
        ) as SQL,
      );
    }
  }
  const parts = [...(ids.length > 0 ? [inArray(repos.id, ids)] : []), ...named];
  return parts.length === 0 ? FALSE : (or(...parts) as SQL);
}

function prepare(params: SearchParams): Prepared {
  const query = normalizeSearchQuery(params.q);
  return {
    query,
    tsQuery: sql`websearch_to_tsquery(${searchConfig}, ${query})`,
    repoFilter: repoFilter(params.repo),
    typeFilter: valueFilter(normalizeFilterValues(params.type), sql`${documents.type}`),
    tagFilter: tagFilter(normalizeFilterValues(params.tag)),
    statusFilter: valueFilter(normalizeFilterValues(params.status), sql`${documents.status}`),
    limit: searchLimit(params.limit),
    offset: searchOffset(params.offset),
  };
}

function tagFilter(values: readonly string[] | undefined): SQL {
  if (values === undefined) return TRUE;
  if (values.length === 0) return FALSE;
  return sql`${documents.tags} && ${textArray(values)}`;
}

/**
 * True when the query has a positive, indexable term. `numnode = 0` is an empty query (only
 * punctuation or operators); a `querytree` of `T` has no positive term (`-draft`, `a or -b`)
 * and would match nearly every document by full scan.
 */
function hasSearchTerm(tsQuery: SQL): SQL {
  return sql`(numnode(${tsQuery}) > 0 and querytree(${tsQuery}) <> 'T')`;
}

/** Visible documents matching the query (no facet filters). Needs `documents` join `repos`. */
function matchCondition(p: Prepared, options: QueryOptions): SQL {
  return and(
    visibleRepos(options),
    hasSearchTerm(p.tsQuery),
    sql`${documents.searchVector} @@ ${p.tsQuery}`,
  ) as SQL;
}

const rank = (p: Prepared) =>
  sql`ts_rank(${sql.param(`{${RANK_WEIGHTS.join(",")}}`)}::float4[], ${documents.searchVector}, ${p.tsQuery})`;

/**
 * Total result order: rank, then repository (case-insensitive, then exact, in byte order), then
 * path, then id. `INNER_ORDER` ranks the matches; `PAGE_ORDER` keeps that order on the page.
 */
const INNER_ORDER = sql`"rank" desc, lower(${repos.owner}) collate "C", lower(${repos.name}) collate "C", ${repos.owner} collate "C", ${repos.name} collate "C", ${documents.path} collate "C", ${documents.id}`;
const PAGE_ORDER = sql`page."rank" desc, lower(page."owner") collate "C", lower(page."name") collate "C", page."owner" collate "C", page."name" collate "C", page."path" collate "C", page."id"`;

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
}

function toHeading(value: unknown): SearchHeading | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { depth, text, slug } = value as { depth?: unknown; text?: unknown; slug?: unknown };
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 6) return null;
  if (typeof text !== "string" || typeof slug !== "string" || slug === "") return null;
  return { depth, text, slug };
}

/**
 * The first cleaned candidate that still has a highlight (the body, then the description), else
 * the first non-empty one (the description, then the body start). A match can be cleaned away
 * (it was inside a link URL or a tag), so highlights are checked after cleaning.
 */
function pickSnippet(body: string | null, description: string | null): string {
  const cleanedBody = body === null ? "" : cleanSnippet(body);
  if (cleanedBody.includes(HIGHLIGHT_START)) return cleanedBody;
  const cleanedDescription = description === null ? "" : cleanSnippet(description);
  if (cleanedDescription.includes(HIGHLIGHT_START)) return cleanedDescription;
  return cleanedDescription !== "" ? cleanedDescription : cleanedBody;
}

/**
 * One page of search results. Empty (and no database round trip) for an empty query; a query
 * with no positive term, or that matches nothing, gives `total: 0`. Never throws on input.
 */
export async function searchDocuments(
  db: Db,
  params: SearchParams,
  options: QueryOptions = {},
): Promise<SearchResult> {
  const p = prepare(params);
  const empty: SearchResult = {
    query: p.query,
    hits: [],
    total: 0,
    limit: p.limit,
    offset: p.offset,
  };
  if (p.query === "" || p.offset > MAX_SEARCH_OFFSET) return empty;

  // `translate` swaps `<` for HEADLINE_ANGLE (ts_headline would swallow tags) and deletes any
  // marker already in the source.
  const translateFrom = sql.param(`<${HIGHLIGHT_START}${HIGHLIGHT_END}`);
  const translateTo = sql.param(HEADLINE_ANGLE);
  const headlineOptions = sql.param(HEADLINE_OPTIONS);
  // Query lexemes, to rank headings by how many terms they contain. Negated terms cannot occur in
  // a matching document, so counting them is harmless.
  const queryLexemes = sql`tsvector_to_array(to_tsvector(${searchConfig}, ${p.query}))`;
  const headingText = sql`(h.value ->> 'text')`;
  const headingVector = sql`to_tsvector(${searchConfig}, ${headingText})`;

  // The inner query ranks and pages using only small columns; the outer one reads body and
  // headings and runs ts_headline for the page's rows only.
  const result = await db.execute(sql`
    select
      page."id", page."rank", page."total",
      ${repos.id} as "repo_id", ${repos.owner} as "owner", ${repos.name} as "name",
      ${repos.visibility} as "visibility", ${repos.docsPath} as "docs_path",
      ${documents.path} as "path", ${documents.title} as "title",
      ${documents.description} as "description", ${documents.type} as "type",
      ${documents.tags} as "tags", ${documents.status} as "status",
      ${documents.reserved} as "reserved",
      ts_headline(${searchConfig},
        translate(left(${documents.body}, ${MAX_HEADLINE_SOURCE_CHARS}), ${translateFrom}, ${translateTo}),
        ${p.tsQuery}, ${headlineOptions}) as "body_snippet",
      case when ${documents.description} is null then null else
        ts_headline(${searchConfig}, translate(${documents.description}, ${translateFrom}, ${translateTo}),
          ${p.tsQuery}, ${headlineOptions}) end as "description_snippet",
      best_heading."value" as "heading"
    from (
      select ${documents.id} as "id", ${rank(p)} as "rank", count(*) over () as "total",
        ${repos.owner} as "owner", ${repos.name} as "name", ${documents.path} as "path"
      from ${documents}
      inner join ${repos} on ${repos.id} = ${documents.repoId}
      where ${matchCondition(p, options)}
        and ${p.repoFilter} and ${p.typeFilter} and ${p.tagFilter} and ${p.statusFilter}
      order by ${INNER_ORDER}
      limit ${p.limit} offset ${p.offset}
    ) as page
    inner join ${documents} on ${documents.id} = page."id"
    inner join ${repos} on ${repos.id} = ${documents.repoId}
    left join lateral (
      select h.value
      from jsonb_array_elements(case when jsonb_typeof(${documents.headings}) = 'array'
        then ${documents.headings} else '[]'::jsonb end) with ordinality as h(value, ord)
      where jsonb_typeof(h.value) = 'object'
        and jsonb_typeof(h.value -> 'text') = 'string'
        and jsonb_typeof(h.value -> 'slug') = 'string'
        and (h.value ->> 'slug') <> ''
        and jsonb_typeof(h.value -> 'depth') = 'number'
        and (h.value ->> 'depth')::numeric in (1, 2, 3, 4, 5, 6)
        and tsvector_to_array(${headingVector}) && ${queryLexemes}
      order by (${headingVector} @@ ${p.tsQuery}) desc,
        (select count(*) from unnest(tsvector_to_array(${headingVector})) as l(x)
          where l.x = any(${queryLexemes})) desc,
        h.ord
      limit 1
    ) as best_heading on true
    where ${visibleRepos(options)}
    order by ${PAGE_ORDER}
  `);

  const rows = result.rows;
  const first = rows[0];
  const total = first === undefined ? 0 : int(first.total);
  const hits = rows.map((row): SearchHit => {
    const visibility: RepoVisibility = row.visibility === "private" ? "private" : "public";
    const reserved = row.reserved === "index" || row.reserved === "log" ? row.reserved : null;
    return {
      repo: {
        id: int(row.repo_id),
        owner: String(row.owner),
        name: String(row.name),
        visibility,
        docsPath: str(row.docs_path),
      },
      doc: {
        path: String(row.path),
        title: String(row.title),
        description: str(row.description),
        type: str(row.type),
        tags: stringList(row.tags),
        status: str(row.status),
        reserved,
      },
      rank: int(row.rank),
      snippet: pickSnippet(str(row.body_snippet), str(row.description_snippet)),
      heading: toHeading(row.heading),
    };
  });
  // A page past the end still reports the total, so the UI can say "page out of range".
  if (hits.length === 0 && p.offset > 0) {
    const facets = await searchFacets(db, params, options);
    return { ...empty, total: facets.total };
  }
  return { query: p.query, hits, total, limit: p.limit, offset: p.offset };
}

/**
 * Facet counts for a search: per repository, type, tag (the most frequent) and status, each
 * counted over the matches narrowed by the other kinds' filters (disjunctive facets), plus the
 * total with every filter. Paging is ignored. Empty for an empty query.
 */
export async function searchFacets(
  db: Db,
  params: SearchParams,
  options: QueryOptions = {},
): Promise<SearchFacets> {
  const p = prepare(params);
  const empty: SearchFacets = {
    query: p.query,
    total: 0,
    repos: [],
    types: [],
    tags: [],
    statuses: [],
  };
  if (p.query === "") return empty;

  // One pass over the matches; each document carries whether it passes each filter kind.
  const result = await db.execute(sql`
    with m as materialized (
      select ${repos.id} as "repo_id", ${repos.owner} as "owner", ${repos.name} as "name",
        ${documents.type} as "type", ${documents.tags} as "tags", ${documents.status} as "status",
        coalesce(${p.repoFilter}, false) as "r", coalesce(${p.typeFilter}, false) as "ty",
        coalesce(${p.tagFilter}, false) as "tg", coalesce(${p.statusFilter}, false) as "s"
      from ${documents}
      inner join ${repos} on ${repos.id} = ${documents.repoId}
      where ${matchCondition(p, options)}
    )
    select 'total' as "kind", null::int as "repo_id", null::text as "owner", null::text as "value",
      count(*)::int as "count"
    from m where r and ty and tg and s
    union all
    (select 'repo', repo_id, min(owner), min(name), count(*)::int
      from m where ty and tg and s
      group by repo_id
      order by count(*) desc, lower(min(owner)) collate "C", lower(min(name)) collate "C", repo_id
      limit ${MAX_FACET_VALUES.repos})
    union all
    (select 'type', null, null, type, count(*)::int
      from m where r and tg and s and type is not null
      group by type order by count(*) desc, type collate "C"
      limit ${MAX_FACET_VALUES.types})
    union all
    (select 'tag', null, null, t.tag, count(*)::int
      from m cross join lateral unnest(m.tags) as t(tag)
      where r and ty and s
      group by t.tag order by count(*) desc, t.tag collate "C"
      limit ${MAX_FACET_VALUES.tags})
    union all
    (select 'status', null, null, status, count(*)::int
      from m where r and ty and tg and status is not null
      group by status order by count(*) desc, status collate "C"
      limit ${MAX_FACET_VALUES.statuses})
  `);

  let total = 0;
  const repoCounts: RepoFacetCount[] = [];
  const types: FacetCount[] = [];
  const tags: FacetCount[] = [];
  const statuses: FacetCount[] = [];
  for (const row of result.rows) {
    const count = int(row.count);
    const value = str(row.value);
    switch (row.kind) {
      case "total":
        total = count;
        break;
      case "repo":
        repoCounts.push({
          id: int(row.repo_id),
          owner: String(row.owner),
          name: String(row.value),
          count,
        });
        break;
      case "type":
        if (value !== null) types.push({ value, count });
        break;
      case "tag":
        if (value !== null) tags.push({ value, count });
        break;
      case "status":
        if (value !== null) statuses.push({ value, count });
        break;
    }
  }
  return { query: p.query, total, repos: repoCounts, types, tags, statuses };
}

/** The type, tag and status filters of a repository's table of contents (task 11.2, 11.3). */
export interface RepoFacetFilters {
  /** OKF types, exact and case-sensitive. */
  readonly type?: unknown;
  /** Tags, exact. A document matches when it has any of them. */
  readonly tag?: unknown;
  /** Statuses, exact. */
  readonly status?: unknown;
}

export interface RepoFacets {
  /** Documents passing every filter (what the narrowed tree shows). */
  readonly total: number;
  /** Non-null types as authored (`Metric` and `metric` are two values), by count then value. */
  readonly types: readonly FacetCount[];
  readonly tags: readonly FacetCount[];
  readonly statuses: readonly FacetCount[];
}

/**
 * Facet counts for one repository's table of contents: the distinct `type`, tag and `status`
 * values of its documents with how many documents have each. Disjunctive like `searchFacets`: each
 * kind is counted over the documents passing the OTHER kinds' filters, so selecting a type still
 * shows the counts of the other types. Reserved files (`index.md`, `log.md`) and documents without
 * a value are never counted: they are not typed concepts. Values are exact (no case folding or
 * trimming). Empty for an unknown or hidden repository (visibility filter applied), never throws
 * on input.
 */
export async function getRepoFacets(
  db: Db,
  repo: RepoRef,
  filters: RepoFacetFilters = {},
  options: QueryOptions = {},
): Promise<RepoFacets> {
  const empty: RepoFacets = { total: 0, types: [], tags: [], statuses: [] };
  const where = await repoCondition(db, repo, options);
  if (where === null) return empty;
  const typeFilter = valueFilter(normalizeFilterValues(filters.type), sql`${documents.type}`);
  const tagFilterSql = tagFilter(normalizeFilterValues(filters.tag));
  const statusFilter = valueFilter(normalizeFilterValues(filters.status), sql`${documents.status}`);

  const result = await db.execute(sql`
    with m as materialized (
      select ${documents.id} as "id", ${documents.type} as "type", ${documents.tags} as "tags",
        ${documents.status} as "status", coalesce(${typeFilter}, false) as "ty", coalesce(${tagFilterSql}, false) as "tg",
        coalesce(${statusFilter}, false) as "s"
      from ${documents}
      inner join ${repos} on ${repos.id} = ${documents.repoId}
      where ${visibleRepos(options)} and ${where} and ${documents.reserved} is null
    )
    select 'total' as "kind", null::text as "value", count(*)::int as "count"
    from m where ty and tg and s
    union all
    (select 'type', type, count(*)::int
      from m where tg and s and type is not null
      group by type order by count(*) desc, type collate "C"
      limit ${MAX_FACET_VALUES.types})
    union all
    (select 'tag', t.tag, count(distinct m.id)::int
      from m cross join lateral unnest(m.tags) as t(tag)
      where ty and s
      group by t.tag order by count(distinct m.id) desc, t.tag collate "C"
      limit ${MAX_FACET_VALUES.tags})
    union all
    (select 'status', status, count(*)::int
      from m where ty and tg and status is not null
      group by status order by count(*) desc, status collate "C"
      limit ${MAX_FACET_VALUES.statuses})
  `);

  let total = 0;
  const types: FacetCount[] = [];
  const tags: FacetCount[] = [];
  const statuses: FacetCount[] = [];
  for (const row of result.rows) {
    const count = int(row.count);
    const value = str(row.value);
    switch (row.kind) {
      case "total":
        total = count;
        break;
      case "type":
        if (value !== null) types.push({ value, count });
        break;
      case "tag":
        if (value !== null) tags.push({ value, count });
        break;
      case "status":
        if (value !== null) statuses.push({ value, count });
        break;
    }
  }
  return { total, types, tags, statuses };
}
