/**
 * Pure search input and snippet helpers (task 10.1), shared by the query layer
 * (`src/server/queries/search.ts`), the search page (10.3) and the command palette (10.4). No
 * database and no React here.
 *
 * Query text is never parsed into tsquery syntax by us: the query layer hands the normalized
 * string to `websearch_to_tsquery` as a bound parameter (search spec "Query safety"). These
 * helpers only bound its size and remove characters Postgres cannot take (NUL, lone surrogates).
 */

/**
 * Snippet highlight markers. `ts_headline` wraps every matched term in these two private-use
 * code points instead of HTML, so document text can never inject markup: the UI renders the
 * snippet as text and turns each START...END span into a `<mark>` (see `splitHighlights`).
 * Both are removed from the source before `ts_headline` runs and from the query text.
 */
export const HIGHLIGHT_START = "";
export const HIGHLIGHT_END = "";

/** Longest query, in code points, sent to Postgres. Longer input is cut at a code point. */
export const MAX_QUERY_CHARS = 256;
/** Results per page when the caller gives none. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** Most results per page. */
export const MAX_SEARCH_LIMIT = 100;
/** Deepest offset served; a later page is empty (ranking all matches deeper is wasted work). */
export const MAX_SEARCH_OFFSET = 1000;
/** Most values per filter kind (repo, type, tag, status); extra values are ignored. */
export const MAX_FILTER_VALUES = 20;
/** Longest filter value, in UTF-16 units. A longer one cannot be a stored value. */
export const MAX_FILTER_CHARS = 256;

// C0/C1 controls other than tab/newline/CR, lone surrogates, and the highlight markers.
const UNSAFE_QUERY_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LONE_SURROGATE_SOURCE =
  "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";
const LONE_SURROGATES = new RegExp(LONE_SURROGATE_SOURCE, "g");
const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE_SOURCE);

/**
 * The query text to search for: control characters, NUL, lone surrogates and the highlight
 * markers become spaces, whitespace is collapsed and trimmed, and the result is cut to
 * `MAX_QUERY_CHARS` code points (never inside a surrogate pair). Anything that is not a string
 * is the empty query. Operators and quotes are kept: `websearch_to_tsquery` reads them.
 */
export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  // Bound the work before the regexes run on a huge input.
  const head = value.length > MAX_QUERY_CHARS * 8 ? value.slice(0, MAX_QUERY_CHARS * 8) : value;
  const cleaned = head
    .replace(LONE_SURROGATES, " ")
    .replace(UNSAFE_QUERY_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const points = Array.from(cleaned);
  return points.length <= MAX_QUERY_CHARS
    ? cleaned
    : points.slice(0, MAX_QUERY_CHARS).join("").trimEnd();
}

/**
 * The values of one filter kind, as given (case and spacing kept: OKF `type` is free-form and
 * case-sensitive).
 * - `undefined`: no filter (absent, or an empty list).
 * - `[]`: values were given but none can match a stored value (empty, too long, containing NUL,
 *   not a string), so the filter matches nothing. Dropping it would widen the results instead.
 * Duplicates are removed (order kept) and at most `MAX_FILTER_VALUES` are kept.
 */
export function normalizeFilterValues(value: unknown): readonly string[] | undefined {
  const list: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : value === undefined || value === null
      ? []
      : [value];
  if (list.length === 0) return undefined;
  const out: string[] = [];
  for (const item of list) {
    if (out.length >= MAX_FILTER_VALUES) break;
    if (
      typeof item === "string" &&
      item.length > 0 &&
      item.length <= MAX_FILTER_CHARS &&
      !item.includes("\u0000") &&
      !HAS_LONE_SURROGATE.test(item) &&
      !out.includes(item)
    ) {
      out.push(item);
    }
  }
  return out;
}

/** A repository filter value: `owner/name` from a URL, or a row id. */
export type RepoFilterValue =
  { readonly owner: string; readonly name: string } | { readonly id: number };

const MAX_INT4 = 2_147_483_647;

/**
 * Parses one repository filter value: a positive integer id, or `owner/name` (exactly one `/`,
 * both sides non-empty). Anything else is null (it can name no repository).
 */
export function parseRepoFilterValue(value: unknown): RepoFilterValue | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4 ? { id: value } : null;
  }
  if (typeof value !== "string" || value.length > MAX_FILTER_CHARS || value.includes("\u0000")) {
    return null;
  }
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (owner === "" || name === "" || HAS_LONE_SURROGATE.test(value)) return null;
  return { owner, name };
}

/**
 * Repository filter values, with the same `undefined` / `[]` meaning as `normalizeFilterValues`.
 */
export function normalizeRepoFilter(value: unknown): readonly RepoFilterValue[] | undefined {
  const list: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : value === undefined || value === null
      ? []
      : [value];
  if (list.length === 0) return undefined;
  const out: RepoFilterValue[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= MAX_FILTER_VALUES) break;
    const parsed = parseRepoFilterValue(item);
    if (parsed === null) continue;
    const key = "id" in parsed ? `#${parsed.id}` : `${parsed.owner}/${parsed.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/** Results per page: an integer clamped to 1..`MAX_SEARCH_LIMIT`, else the default. */
export function searchLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  const n = Math.trunc(value);
  if (n < 1) return DEFAULT_SEARCH_LIMIT;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

/** Results to skip: a non-negative integer, else 0. May exceed `MAX_SEARCH_OFFSET` (empty page). */
export function searchOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

/**
 * Turns a raw `ts_headline` fragment into display text. Task 10.2 replaces the body with the
 * real cleaning (strip Markdown and HTML markup, decode entities, keep the highlight markers).
 * Until then it only collapses whitespace. Pure; must never add markup.
 */
export function cleanSnippet(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/** A run of snippet text, highlighted or not. */
export interface SnippetPart {
  readonly text: string;
  readonly highlighted: boolean;
}

/**
 * Splits a snippet on the highlight markers so the UI can render highlighted runs as `<mark>`
 * and everything else as text. Unbalanced markers are tolerated (a stray END is dropped; text
 * after an unclosed START is highlighted). Empty runs are omitted.
 */
export function splitHighlights(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let highlighted = false;
  let current = "";
  const flush = () => {
    if (current !== "") parts.push({ text: current, highlighted });
    current = "";
  };
  for (const ch of snippet) {
    if (ch === HIGHLIGHT_START) {
      if (!highlighted) {
        flush();
        highlighted = true;
      }
    } else if (ch === HIGHLIGHT_END) {
      if (highlighted) {
        flush();
        highlighted = false;
      }
    } else {
      current += ch;
    }
  }
  flush();
  return parts;
}
