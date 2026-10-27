import "server-only";
import type { DomainEventInput } from "@docmyrepos/core";

import {
  UNAVAILABLE_BODY,
  paletteResponse,
  parsePaletteRequest,
  toPaletteHit,
  type PaletteResponse,
} from "@docmyrepos/core/internal/palette";
import type { SearchState } from "@docmyrepos/core/internal/search-params";

import { expectedFailureKind } from "./home";
import { searchDocuments, type QueryOptions } from "./queries";
import { searchResultItem } from "./search-page";
import { type DbSource } from "./db/client";
import { logger, type LogFn } from "./log";

/**
 * `GET /api/search` for the command palette (task 10.4, search spec "Global search access" and
 * "Query safety"). The route file is a thin wrapper; the logic lives here so it can be tested
 * without Next.js.
 *
 * What it does: reads `q`, `limit` (1 to 10, default 8) and optional `repo` filters from the query
 * string with the same normalizers the search page uses (`packages/core/src/search-params.ts`), runs the
 * search through the shared query layer (`searchDocuments`, so the single visibility filter applies
 * to every hit), and answers with `{ q, total, hits, seeAll }`: only the fields a palette row shows
 * (`PaletteHit`). It reads Postgres only, never GitHub.
 *
 * Why not `loadSearchPage`: that also counts facets, a second query the palette does not use, and
 * the palette fires one request per pause in typing. Row building (`searchResultItem`) and failure
 * classification (`expectedFailureKind`) are shared with the page.
 *
 * Safety
 *  - The query is plain text: it reaches Postgres only as a bound parameter of
 *    `websearch_to_tsquery` (query layer). Hostile input gives results or an empty list.
 *  - An empty query answers `{ hits: [], total: 0 }` without touching the database.
 *  - Only `GET`; any other method is 405 with `Allow: GET`. The request body is never read.
 *  - Every answer is `Cache-Control: no-store` (hits can be private-repository content) and
 *    `nosniff`; `Vary` lists the headers a future per-viewer visibility filter would read.
 *  - A failure of any kind is `503 {"error":"unavailable"}`. The body and the log never contain the
 *    query, the error text or a connection detail; the log line is a fixed message plus the error
 *    kind. It never throws.
 *  - Cost control is cheap on purpose: `limit` is capped at 10, `offset` is always 0, the query is
 *    cut to 256 characters, and at most `MAX_IN_FLIGHT` searches run at once in this process (more
 *    get 503 with `Retry-After`). That is a safety valve, NOT rate limiting: a per-client limit
 *    belongs in the reverse proxy in front of the app, which sees the client address.
 */

/** Searches running at once in this process. Above it the route answers 503 straight away. */
export const MAX_IN_FLIGHT = 16;

export interface SearchApiDeps {
  /** Receives `search.performed` (result count and scope, never the query). */
  readonly emit?: (event: DomainEventInput) => void;
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
  readonly db: DbSource;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
  /** Query options (tests swap the visibility filter to prove the shared layer is used). */
  readonly options?: QueryOptions;
  /** Concurrency cap. Default `MAX_IN_FLIGHT`. */
  readonly maxInFlight?: number;
}

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  Vary: "Cookie, Authorization, Accept-Encoding",
  "X-Content-Type-Options": "nosniff",
} as const;

function json(body: PaletteResponse | typeof UNAVAILABLE_BODY, init: ResponseInit = {}): Response {
  const headers = new Headers(BASE_HEADERS);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function unavailable(extra?: Record<string, string>): Response {
  return json(UNAVAILABLE_BODY, { status: 503, headers: extra });
}

/** 405 for every method but GET, before anything is read or looked up. */
export function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

let inFlight = 0;

export async function handleSearchRequest(
  request: Request,
  deps: SearchApiDeps,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const log = deps.log ?? logger.error;

  let state: SearchState;
  try {
    state = parsePaletteRequest(new URL(request.url).searchParams);
  } catch {
    // A request URL that does not parse: treat it as no query.
    return json(paletteResponse(parsePaletteRequest(new URLSearchParams()), 0, []));
  }
  if (state.q === "") return json(paletteResponse(state, 0, []));

  // The caller is already gone (the palette aborts superseded requests): do no work.
  if (request.signal.aborted) return unavailable();

  if (inFlight >= (deps.maxInFlight ?? MAX_IN_FLIGHT)) {
    return unavailable({ "Retry-After": "1" });
  }
  inFlight += 1;
  try {
    const db = await deps.db();
    const result = await searchDocuments(
      db,
      { q: state.q, repo: state.repos, limit: state.limit, offset: 0 },
      deps.options,
    );
    const hits = result.hits
      .slice(0, state.limit)
      .map((hit) => toPaletteHit(searchResultItem(hit)));
    deps.emit?.({
      name: "search.performed",
      payload: { resultCount: result.total, scoped: state.repos.length > 0 },
    });
    return json(paletteResponse(state, result.total, hits));
  } catch (error) {
    // Log the kind of an expected failure (database down, bad configuration) and nothing of an
    // unexpected one: the message of either can carry the query or a connection detail.
    let kind: string | null = null;
    try {
      kind = expectedFailureKind(error);
    } catch {
      // classification must not break the answer
    }
    try {
      log("search_api.failed", { reason: kind ?? "unexpected error" });
    } catch {
      // a failing logger must not break the answer
    }
    return unavailable();
  } finally {
    inFlight -= 1;
  }
}
