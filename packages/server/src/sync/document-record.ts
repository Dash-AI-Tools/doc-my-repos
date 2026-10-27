import type { CodeOwnerRef, Heading } from "../db/schema";
import { extractMetadata } from "../docs/extract";
import {
  parseFrontmatter,
  stripNul,
  toWellFormed,
  type FrontmatterData,
  type JsonValue,
} from "../docs/frontmatter";
import { reservedKind, type ReservedKind } from "../docs/okf";
import { DEFAULT_MAX_FILE_BYTES } from "./tree";

/**
 * Turns one fetched Markdown file into the row the sync stores (task 5.6). Pure: no database, no
 * GitHub. The stored form is the parsed document (body, frontmatter, derived columns), never HTML.
 *
 * Column rules (the spec is silent on several; see the decision log):
 * - `type`: `parseFrontmatter`'s rule, a non-blank string kept verbatim (case and spacing as
 *   authored), else null. A non-string `type` stays in `frontmatter` (so OKF detection, which tests
 *   key presence, still counts it) but the column is null. A value longer than
 *   `MAX_FACET_CHARS` is also null in the column, with a warning: the column has a btree index,
 *   whose entries cannot exceed about 2.7 KB, and no real type is that long.
 * - `tags`: frontmatter `tags` as a list of strings, kept verbatim and in order, exact duplicates
 *   and blank entries dropped. A single string is one tag (no comma splitting: OKF tags are a
 *   list). Non-string entries, entries over `MAX_FACET_CHARS` and entries past `MAX_TAGS` are
 *   dropped with a warning. Any other value gives no tags and a warning.
 * - `status`: a non-blank string kept verbatim, else null (a non-string or over-long value warns).
 * - `title`, `description`, `headings`: from `extractMetadata`, given the path relative to the
 *   docs folder, so the docs-root `index.md` is titled from its file name rather than the folder.
 * - `reserved`: `index` or `log` for `index.md`/`log.md` at any depth (`reservedKind`).
 *
 * Size: a document whose text is over `maxBytes` (UTF-8, default 256 KB, the tree's per-file cap)
 * is not built. The cap keeps the generated `search_vector` far below Postgres's 1 MB tsvector
 * limit; the caller skips such a file with a warning instead of storing a truncated body.
 *
 * Text safety: NUL characters are removed and lone surrogates replaced by U+FFFD in every string,
 * including JSON keys, because Postgres text and JSONB reject both (`toDbText`, `toDbJson`).
 */

/** Longest `type`, `status` or tag value stored in a column. */
export const MAX_FACET_CHARS = 256;
/** Most tags stored per document. */
export const MAX_TAGS = 100;

export interface DocumentRecord {
  /** Repo-relative path, as in the tree (`docs/a/b.md`). */
  path: string;
  title: string;
  description: string | null;
  type: string | null;
  tags: string[];
  status: string | null;
  headings: Heading[];
  frontmatter: FrontmatterData;
  body: string;
  reserved: ReservedKind | null;
}

export type BuildResult =
  | { ok: true; record: DocumentRecord; warnings: string[] }
  | { ok: false; path: string; reason: "too_large"; bytes: number; warnings: string[] };

export interface BuildOptions {
  /** The repo's docs folder (`findDocsFolder` output), or null. Used for the file-name title. */
  docsFolder: string | null;
  /** Largest text accepted, in UTF-8 bytes. Default 256 KB. */
  maxBytes?: number;
}

/** NUL removed and lone surrogates replaced: safe for Postgres text. */
export function toDbText(value: string): string {
  return toWellFormed(stripNul(value));
}

/** Deep copy with `toDbText` applied to every string and object key. */
export function toDbJson<T extends JsonValue>(value: T): T {
  if (typeof value === "string") return toDbText(value) as T;
  if (Array.isArray(value)) return value.map((item: JsonValue) => toDbJson(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [toDbText(key), toDbJson(child as JsonValue)]),
    ) as T;
  }
  return value;
}

/** `toDbText` over a heading list (text and slug), so a row can never carry NUL. */
export function toDbHeadings(headings: readonly Heading[]): Heading[] {
  return headings.map((h) => ({ depth: h.depth, text: toDbText(h.text), slug: toDbText(h.slug) }));
}

/** `toDbText` over code owner handles. */
export function toDbOwners(owners: readonly CodeOwnerRef[]): CodeOwnerRef[] {
  return owners.map((o) => ({ handle: toDbText(o.handle), kind: o.kind }));
}

function docsRelative(path: string, docsFolder: string | null): string {
  if (docsFolder === null) return path;
  const prefix = `${docsFolder.replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

function normalizeTags(value: JsonValue | undefined, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  const list: readonly JsonValue[] | null =
    typeof value === "string" ? [value] : Array.isArray(value) ? (value as JsonValue[]) : null;
  if (list === null) {
    warnings.push("frontmatter: `tags` is not a list of strings and was not used");
    return [];
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const item of list) {
    if (typeof item !== "string" || item.length > MAX_FACET_CHARS) {
      if (!(typeof item === "string" && isBlank(item))) dropped = true;
      continue;
    }
    if (isBlank(item) || seen.has(item)) continue;
    if (tags.length >= MAX_TAGS) {
      dropped = true;
      continue;
    }
    seen.add(item);
    tags.push(item);
  }
  if (dropped) warnings.push("frontmatter: some `tags` entries were not usable and were dropped");
  return tags;
}

function facetString(value: JsonValue | undefined, key: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push(`frontmatter: \`${key}\` is not a string and was not used`);
    return null;
  }
  if (isBlank(value)) return null;
  if (value.length > MAX_FACET_CHARS) {
    warnings.push(`frontmatter: \`${key}\` is longer than ${MAX_FACET_CHARS} characters`);
    return null;
  }
  return value;
}

/**
 * Builds the stored row for one doc. Never throws on content; throws a `TypeError` only for a bad
 * `maxBytes`. Warnings are fixed texts that never quote the document.
 */
export function buildDocumentRecord(
  path: string,
  text: string,
  options: BuildOptions,
): BuildResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive integer");
  }
  const safePath = toDbText(path);
  const clean = toDbText(text);
  const bytes = Buffer.byteLength(clean, "utf8");
  if (bytes > maxBytes) {
    return {
      ok: false,
      path: safePath,
      reason: "too_large",
      bytes,
      warnings: [`document skipped: larger than ${maxBytes} bytes`],
    };
  }

  const parsed = parseFrontmatter(clean);
  const warnings = [...parsed.warnings];
  const frontmatter = toDbJson(parsed.frontmatter);
  const meta = extractMetadata({
    body: parsed.body,
    frontmatter,
    path: docsRelative(safePath, options.docsFolder),
  });

  let type = parsed.type;
  if (type !== null && type.length > MAX_FACET_CHARS) {
    warnings.push(`frontmatter: \`type\` is longer than ${MAX_FACET_CHARS} characters`);
    type = null;
  }

  const record: DocumentRecord = {
    path: safePath,
    title: toDbText(meta.title),
    description: meta.description === null ? null : toDbText(meta.description),
    type: type === null ? null : toDbText(type),
    tags: normalizeTags(frontmatter.tags, warnings).map(toDbText),
    status: facetString(frontmatter.status, "status", warnings),
    headings: toDbHeadings(meta.headings),
    frontmatter,
    body: toDbText(parsed.body),
    reserved: reservedKind(safePath),
  };
  return { ok: true, record, warnings };
}
