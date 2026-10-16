import "server-only";

import { docUrl, repoUrl } from "@/lib/routes";
import { offsetFor, computePaging, type SearchState } from "@/lib/search-params";
import {
  buildActiveFilters,
  buildFacetGroups,
  type ResultItemData,
  type SearchPageView,
} from "@/lib/search-view";

import { expectedFailureKind } from "./home";
import { anchorId, SLUG_ID } from "./markdown/sanitize";
import { searchDocuments, searchFacets, type SearchHit } from "./queries";
import { getDb, type Db } from "./db/client";
import { logger, type LogFn } from "./log";

/**
 * Data for the `/search` page (task 10.3). The state comes from the URL (`parseSearchParams`);
 * this runs the two reads of the query layer in parallel and turns them into the view the page
 * renders. It reads Postgres only, through `@/server/queries` (so the shared visibility filter
 * applies to hits and to every facet count), never GitHub.
 *
 * Failure policy: the same as the home page (`src/server/home.ts`). An unreachable database or a
 * missing/invalid configuration renders the in-page error state (HTTP 200, layout kept); anything
 * else is a bug and is rethrown for `error.tsx`. Only a fixed message and the error kind are
 * logged, never the error, a query, or a connection detail. The query text is user input and is
 * not logged either.
 *
 * The command palette (task 10.4) reuses `searchResultItem` for its rows and the same state
 * parser/serializer for its API route.
 */

export interface SearchPageDeps {
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
  readonly db?: () => Db;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
}

/**
 * The link to a document, with the best matching heading as a `#anchor` below the title. The
 * anchor is added only when the doc page really gives that heading an id (the sanitizer keeps a
 * heading id only if it matches `SLUG_ID`, then maps it through `anchorId`); otherwise the link
 * goes to the top of the document, and the section label is still shown.
 */
export function searchResultItem(hit: SearchHit): ResultItemData {
  const { repo, doc, heading } = hit;
  const base =
    docUrl(repo.owner, repo.name, doc.path, repo.docsPath) ?? repoUrl(repo.owner, repo.name);
  // A depth-1 heading is the document's own title, which the document page hides when the body
  // repeats it: no anchor and no "section" label for it.
  const section = heading !== null && heading.depth > 1 ? heading : null;
  // `index.md` and `log.md` are not typed concepts: no type, status or tag chips on their rows.
  const typed = doc.reserved === null;
  const anchored = section !== null && SLUG_ID.test(section.slug);
  return {
    key: `${repo.id}:${doc.path}`,
    title: doc.title,
    href: anchored ? `${base}#${encodeURIComponent(anchorId(section.slug))}` : base,
    repoLabel: `${repo.owner}/${repo.name}`,
    repoHref: repoUrl(repo.owner, repo.name),
    path: doc.path,
    section: section?.text ?? null,
    snippet: hit.snippet,
    isPrivate: repo.visibility === "private",
    type: typed ? doc.type : null,
    status: typed ? doc.status : null,
    tags: typed ? doc.tags : [],
  };
}

export async function loadSearchPage(
  state: SearchState,
  deps: SearchPageDeps = {},
): Promise<SearchPageView> {
  if (state.q === "") return { status: "idle", state };
  const log = deps.log ?? logger.error;
  const db = deps.db ?? (() => getDb().db);
  const params = {
    q: state.q,
    repo: state.repos,
    type: state.types,
    tag: state.tags,
    status: state.statuses,
    limit: state.limit,
    offset: offsetFor(state),
  };
  try {
    const conn = db();
    const [result, facets] = await Promise.all([
      searchDocuments(conn, params),
      searchFacets(conn, params),
    ]);
    // A page past the end (or deeper than the query layer serves) has no hits but the facets
    // still know the total, so the page can say "beyond the last page" instead of "no results".
    const total = result.hits.length === 0 ? facets.total : result.total;
    return {
      status: "ok",
      state,
      query: result.query,
      total,
      hits: result.hits.map(searchResultItem),
      groups: buildFacetGroups(state, facets),
      active: buildActiveFilters(state),
      paging: computePaging(state, total, result.hits.length),
    };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("search_page.failed", { reason: kind });
    return { status: "error", state };
  }
}
