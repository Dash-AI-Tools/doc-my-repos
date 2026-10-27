/**
 * Shared, pure pieces of the command palette (task 10.4): the shape of `GET /api/search`, how its
 * query string is read, and how the browser validates the answer. No React, no database, safe for
 * server and client code, so the route (`packages/server/src/search-api.ts`) and the palette
 * (`packages/ui/src/components/command-palette.tsx`) cannot disagree about the contract.
 *
 * Request: `/api/search?q=<text>&limit=<1-10>&repo=<owner/name>` (`repo` optional and repeatable).
 * Only those three are read: the palette has no type, tag, status or paging controls, so those
 * parameters are ignored rather than half-supported. Response: `{ q, total, hits, seeAll }`; a hit
 * carries only what a palette row shows. Nothing in a hit is HTML: titles and paths are text and
 * the snippet is plain text with the two private-use highlight markers (`splitHighlights`).
 */

import { buildSearchUrl, parseSearchParams, type SearchState } from "./search-params";
import type { ResultItemData } from "./search-view";

export const SEARCH_API_PATH = "/api/search";
/** Rows the palette asks for. */
export const PALETTE_DEFAULT_LIMIT = 8;
/** The most rows the route will return, whatever `limit` asks for. */
export const PALETTE_MAX_LIMIT = 10;

/** One row of the palette. Every string is untrusted text. */
export interface PaletteHit {
  /** Stable key: repository id and document path. */
  readonly key: string;
  readonly title: string;
  /** Root-relative link to the document (with `#anchor` for the best matching heading). */
  readonly href: string;
  /** `owner/name`. */
  readonly repoLabel: string;
  /** Repo-relative path of the document. */
  readonly path: string;
  /** Heading the snippet comes from, or null. */
  readonly section: string | null;
  /** Plain text with highlight markers; may be empty. */
  readonly snippet: string;
  readonly isPrivate: boolean;
}

export interface PaletteResponse {
  /** The query actually searched (normalized). */
  readonly q: string;
  /** Matches across all pages. */
  readonly total: number;
  readonly hits: readonly PaletteHit[];
  /** The full results page for the same query. */
  readonly seeAll: string;
}

/** The body of every failed answer; it never says why. */
export const UNAVAILABLE_BODY = { error: "unavailable" } as const;

const DIGITS = /^[0-9]{1,6}$/;

/** `limit` as the route reads it: 1 to `PALETTE_MAX_LIMIT`, default `PALETTE_DEFAULT_LIMIT`. */
export function paletteLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !DIGITS.test(raw)) return PALETTE_DEFAULT_LIMIT;
  return Math.min(Math.max(Number(raw), 1), PALETTE_MAX_LIMIT);
}

/** The search the route runs for a request's query string. Never throws. */
export function parsePaletteRequest(params: URLSearchParams): SearchState {
  const parsed = parseSearchParams(params);
  return {
    ...parsed,
    types: [],
    tags: [],
    statuses: [],
    page: 1,
    limit: paletteLimit(params.get("limit")),
  };
}

/** The request URL for a query. */
export function paletteRequestUrl(q: string, limit: number = PALETTE_DEFAULT_LIMIT): string {
  return `${SEARCH_API_PATH}?${new URLSearchParams({ q, limit: String(limit) }).toString()}`;
}

/** The palette row for a search result: the subset of fields the palette shows. */
export function toPaletteHit(item: ResultItemData): PaletteHit {
  return {
    key: item.key,
    title: item.title,
    href: item.href,
    repoLabel: item.repoLabel,
    path: item.path,
    section: item.section,
    snippet: item.snippet,
    isPrivate: item.isPrivate,
  };
}

/** The response body for a state and the rows found. */
export function paletteResponse(
  state: SearchState,
  total: number,
  hits: readonly PaletteHit[],
): PaletteResponse {
  return { q: state.q, total, hits, seeAll: buildSearchUrl({ q: state.q }) };
}

/** A root-relative in-app link: one leading `/`, no backslash, no control character. */
export function isSafeAppHref(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return !/[\\\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHit(value: unknown): PaletteHit | null {
  if (!isRecord(value)) return null;
  const { key, title, href, repoLabel, path, section, snippet, isPrivate } = value;
  if (
    typeof key !== "string" ||
    typeof title !== "string" ||
    typeof href !== "string" ||
    typeof repoLabel !== "string" ||
    typeof path !== "string" ||
    typeof snippet !== "string" ||
    typeof isPrivate !== "boolean" ||
    (section !== null && typeof section !== "string") ||
    !isSafeAppHref(href)
  ) {
    return null;
  }
  return { key, title, href, repoLabel, path, section, snippet, isPrivate };
}

/**
 * Reads the answer of `/api/search` in the browser. Anything that does not have the documented
 * shape is `null` (shown as "unavailable"); a row that is malformed, or whose link is not a
 * root-relative in-app path, is dropped. Never throws.
 */
export function parsePaletteResponse(
  value: unknown,
): { readonly total: number; readonly hits: readonly PaletteHit[] } | null {
  if (!isRecord(value) || !Array.isArray(value.hits)) return null;
  const total = value.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
  const hits: PaletteHit[] = [];
  const seen = new Set<string>();
  for (const raw of value.hits as unknown[]) {
    const hit = parseHit(raw);
    if (hit === null || seen.has(hit.key)) continue;
    seen.add(hit.key);
    hits.push(hit);
  }
  return { total, hits };
}
