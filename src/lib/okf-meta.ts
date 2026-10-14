/**
 * The view model of an OKF document's metadata (task 11.4 and 11.5, OKF spec "Metadata card",
 * "Tolerant parsing"). Pure: no React, no database, safe for server and client code.
 *
 * Frontmatter is untrusted and loosely typed (design decision 9): it came from a third-party repo
 * through Postgres JSONB, so any value can be a string, number, boolean, null, list or nested
 * object, and keys are anything (`__proto__`, numbers as text, control characters). Nothing here
 * throws. Every value the page shows is cut down to plain display text first:
 *
 * - Text is cleaned (`cleanText`): C0/C1 control characters, NUL, bidirectional overrides and
 *   isolates (which can reorder text to spoof it) and zero-width marks are dropped, line breaks
 *   are normalized, lone surrogates are replaced, and the length is capped. React renders it as
 *   text, never as HTML.
 * - Structure is capped: at most `MAX_DEPTH` levels, `MAX_ITEMS` entries per list or mapping and
 *   `MAX_NODES` values per field, with the number left out reported (`omitted`).
 * - Only absolute `http:`/`https:` URLs without credentials become links (`safeExternalUrl`).
 *   The spec does not say what `resource` and `sources` hold, so anything else (a relative path,
 *   `javascript:`, `data:`, a bare identifier) is shown as plain text.
 * - Results are built from arrays and fresh objects, never by assigning to a key taken from the
 *   frontmatter, so a `__proto__` key stays data.
 *
 * What the spec fixes: `type` is any string, kept verbatim (never normalized, never matched against
 * a list); unknown keys are preserved and displayed (`unknown`, in the order the stored object
 * yields them: Postgres JSONB sorts keys by length, then bytes, so authoring order is not kept); a
 * document with only `type` has a card with only the type; `status` `draft` and `deprecated` and a
 * `stale_after` in the past are flagged (`buildNotices`).
 *
 * Decisions where the spec is silent:
 * - Known keys are `type`, `tags`, `status`, `description`, `resource`, `sources`, `generated`,
 *   `verified`, `stale_after`, plus `title` (it is the page heading) and `okf_version` (it is the
 *   repository's OKF badge). A known key whose value has an unusable shape (`status: [a, b]`,
 *   `description: {x: 1}`) is listed with the unknown keys instead, so nothing is hidden.
 * - Dates: `YYYY-MM-DD`, or ISO 8601 with a time (`T` or a space; seconds, fraction and a `Z` or
 *   `+hh:mm` offset optional; no offset means UTC). Anything else, an impossible date such as
 *   `2026-02-29` included, is "invalid": shown as written with a hint, and it never raises a warning.
 *   All date math is UTC, so the result does not depend on the server's time zone.
 * - `stale_after` as a date alone is valid through the end of that UTC day: it is stale once the
 *   next UTC day has begun. With a time it is stale once that instant has passed. A future date
 *   raises no warning.
 * - A status is a notice when it equals `deprecated` or `draft` ignoring case and surrounding
 *   whitespace; the status is still displayed as authored.
 */

import { normalizeFilterValues } from "./search";

export const MAX_TEXT = 500;
export const MAX_KEY = 120;
export const MAX_ITEMS = 20;
export const MAX_DEPTH = 4;
export const MAX_NODES = 200;
export const MAX_UNKNOWN = 50;
export const MAX_URL = 2048;

const DAY_MS = 86_400_000;

/** `\uXXXX` escape text for a code point, for building character classes from numbers. */
function hex(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

function charClass(ranges: readonly (readonly [number, number?])[]): string {
  const parts = ranges.map(([from, to]) =>
    to === undefined ? hex(from) : `${hex(from)}-${hex(to)}`,
  );
  return `[${parts.join("")}]`;
}

// Removed from display text: C0 controls except tab and line feed, DEL and the C1 range, the Arabic
// letter mark, zero-width space, left-to-right and right-to-left marks, bidirectional
// embeddings/overrides/isolates and the byte order mark. Line breaks are normalized beforehand.
// The classes are built from numbers so that no invisible character sits in this source file.
const INVISIBLE = new RegExp(
  charClass([
    [0, 8],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x61c],
    [0x200b],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0xfeff],
  ]),
  "g",
);
const LINE_BREAKS = new RegExp(`\\r\\n?|${charClass([[0x2028, 0x2029], [0x85]])}`, "g");
// Whitespace, controls, direction marks, backslash and other separators: none belongs in a URL.
const UNSAFE_URL_CHARS = new RegExp(
  `${charClass([
    [0, 0x20],
    [0x7f, 0xa0],
    [0x1680],
    [0x2000, 0x200f],
    [0x2028, 0x202f],
    [0x205f, 0x2069],
    [0x3000],
    [0xfeff],
  ])}|\\\\`,
);
const REPLACEMENT = String.fromCharCode(0xfffd);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export interface CleanText {
  readonly text: string;
  /** The input was longer than `max` characters (or than the part inspected). */
  readonly truncated: boolean;
}

/**
 * Display text for an untrusted string: invisible and direction-changing characters removed,
 * lone surrogates replaced, at most `max` code points. Line breaks are kept (as `\n`) only with
 * `keepNewlines`; otherwise runs of whitespace become one space and the ends are trimmed. Only a
 * bounded prefix of a huge string is inspected.
 */
export function cleanText(input: string, max = MAX_TEXT, keepNewlines = false): CleanText {
  const limit = Math.max(0, Math.floor(max));
  const bound = limit * 4 + 64;
  const prefix = input.length > bound ? input.slice(0, bound) : input;
  let text = prefix
    .replace(LINE_BREAKS, "\n")
    .replace(INVISIBLE, "")
    .replace(LONE_SURROGATE, REPLACEMENT);
  text = keepNewlines
    ? text
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text.replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  if (points.length > limit)
    return { text: points.slice(0, limit).join("").trimEnd(), truncated: true };
  return { text, truncated: prefix.length < input.length };
}

/** The same, as one string with an ellipsis when it was cut. For labels and chips. */
export function shortText(input: string, max = MAX_KEY): string {
  const { text, truncated } = cleanText(input, max);
  return truncated ? `${text}…` : text;
}

/**
 * `value` as an absolute http(s) URL safe to put in an `href`, or null. Rejects other schemes,
 * relative references, credentials in the URL, whitespace or control characters anywhere in it
 * (browsers strip some of them, which can turn text into a different URL) and anything over
 * `MAX_URL` characters.
 */
export function safeExternalUrl(value: string): string | null {
  if (value.length > MAX_URL * 2) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (UNSAFE_URL_CHARS.test(trimmed)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// --- display values -------------------------------------------------------------------------

/** A frontmatter value reduced to something safe and bounded to display. */
export type DisplayValue =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly truncated: boolean;
      readonly scalar: "string" | "number" | "boolean" | "null";
    }
  | { readonly kind: "list"; readonly items: readonly DisplayValue[]; readonly omitted: number }
  | {
      readonly kind: "map";
      readonly entries: readonly { readonly key: string; readonly value: DisplayValue }[];
      readonly omitted: number;
    }
  /** Nested deeper than `MAX_DEPTH`: only a size summary (`3 items`, `2 fields`). */
  | { readonly kind: "deep"; readonly summary: string };

interface Budget {
  nodes: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describe(value: unknown, budget: Budget, depth: number): DisplayValue {
  budget.nodes += 1;
  if (value === null || value === undefined) {
    return { kind: "text", text: "null", truncated: false, scalar: "null" };
  }
  if (typeof value === "string") {
    const { text, truncated } = cleanText(value, MAX_TEXT, true);
    return { kind: "text", text, truncated, scalar: "string" };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return { kind: "text", text: String(value), truncated: false, scalar: "number" };
  }
  if (typeof value === "boolean") {
    return { kind: "text", text: String(value), truncated: false, scalar: "boolean" };
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return { kind: "deep", summary: plural(value.length, "item", "items") };
    }
    const items: DisplayValue[] = [];
    let omitted = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (items.length >= MAX_ITEMS || budget.nodes >= MAX_NODES) {
        omitted = value.length - i;
        break;
      }
      items.push(describe(value[i], budget, depth + 1));
    }
    return { kind: "list", items, omitted };
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (depth >= MAX_DEPTH)
      return { kind: "deep", summary: plural(keys.length, "field", "fields") };
    const entries: { key: string; value: DisplayValue }[] = [];
    let omitted = 0;
    for (let i = 0; i < keys.length; i += 1) {
      if (entries.length >= MAX_ITEMS || budget.nodes >= MAX_NODES) {
        omitted = keys.length - i;
        break;
      }
      const key = keys[i] ?? "";
      entries.push({ key: shortText(key), value: describe(value[key], budget, depth + 1) });
    }
    return { kind: "map", entries, omitted };
  }
  // functions, symbols: not JSON, but never throw on them
  return { kind: "text", text: "", truncated: false, scalar: "string" };
}

/** `value` as bounded display data (depth, width and total size capped, text cleaned). */
export function toDisplayValue(value: unknown): DisplayValue {
  return describe(value, { nodes: 0 }, 0);
}

/** A flat, one-line text for a value, for places that have room for text only. */
export function displayText(value: unknown, max = MAX_KEY): string {
  if (typeof value === "string") return shortText(value, max);
  const shown = toDisplayValue(value);
  const flat = (v: DisplayValue): string => {
    switch (v.kind) {
      case "text":
        return v.truncated ? `${v.text}…` : v.text;
      case "list":
        return `[${v.items.map(flat).join(", ")}${v.omitted > 0 ? ", …" : ""}]`;
      case "map":
        return `{${v.entries.map((e) => `${e.key}: ${flat(e.value)}`).join(", ")}${v.omitted > 0 ? ", …" : ""}}`;
      case "deep":
        return v.summary;
    }
  };
  return shortText(flat(shown), max);
}

// --- links ----------------------------------------------------------------------------------

/** One entry of `resource` or `sources`: text to show, and an external link when it is safe. */
export interface OkfRef {
  readonly label: string;
  readonly href: string | null;
}

export interface OkfRefs {
  readonly items: readonly OkfRef[];
  /** Entries past `MAX_ITEMS`, not shown. */
  readonly omitted: number;
}

const URL_KEYS = ["url", "href", "link", "uri", "resource", "source", "path"] as const;
const LABEL_KEYS = ["title", "name", "label", "text", "description"] as const;

function refFromString(value: string): OkfRef | null {
  const href = safeExternalUrl(value);
  const label = shortText(value, 300);
  if (label === "") return null;
  return { label, href };
}

function refFromObject(value: Record<string, unknown>): OkfRef | null {
  let url: string | null = null;
  for (const key of URL_KEYS) {
    const candidate = nonBlankString(own(value, key));
    if (candidate !== null) {
      url = candidate;
      break;
    }
  }
  let title: string | null = null;
  for (const key of LABEL_KEYS) {
    const candidate = nonBlankString(own(value, key));
    if (candidate !== null) {
      title = shortText(candidate, 300);
      break;
    }
  }
  if (url !== null) {
    const href = safeExternalUrl(url);
    const label = title ?? shortText(url, 300);
    return label === "" ? null : { label, href };
  }
  if (title !== null && title !== "") return { label: title, href: null };
  const label = displayText(value, 300);
  return label === "" || label === "{}" ? null : { label, href: null };
}

function refFrom(value: unknown): OkfRef | null {
  if (typeof value === "string") return refFromString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return { label: String(value), href: null };
  }
  if (isObject(value)) return refFromObject(value);
  if (Array.isArray(value)) {
    const label = displayText(value, 300);
    return label === "[]" || label === "" ? null : { label, href: null };
  }
  return null;
}

/**
 * `resource` or `sources`: a string, an object (`{title, url}`), or a list of those. Entries with
 * nothing to show are skipped. Safe whatever the shape.
 */
export function parseRefs(value: unknown): OkfRefs {
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  const items: OkfRef[] = [];
  let omitted = 0;
  for (const entry of list) {
    const ref = refFrom(entry);
    if (ref === null) continue;
    if (items.length >= MAX_ITEMS) omitted += 1;
    else items.push(ref);
  }
  return { items, omitted };
}

// --- dates ----------------------------------------------------------------------------------

/** A date field as authored, and what could be made of it. */
export interface OkfDate {
  /** The authored value as display text. */
  readonly raw: string;
  readonly valid: boolean;
  /** The instant (UTC); midnight UTC of the day for a date alone. Null when invalid. */
  readonly date: Date | null;
  /** The value had no time of day. */
  readonly dateOnly: boolean;
}

const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?[ ]?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

function utcMillis(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millis = 0,
): number | null {
  const date = new Date(0);
  // setUTCFullYear keeps years 0 to 99 as written (Date.UTC would map them to 1900 to 1999)
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

/** Parses the accepted date forms (see the header). Null when it is not one of them. */
export function parseDateText(text: string): { date: Date; dateOnly: boolean } | null {
  const trimmed = text.trim();
  if (trimmed.length > 64) return null;
  const match = DATE_PATTERN.exec(trimmed);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1) return null;
  if (h === undefined) {
    const time = utcMillis(year, month, day);
    return time === null ? null : { date: new Date(time), dateOnly: true };
  }
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = frac === undefined ? 0 : Number(`${frac}00`.slice(0, 3));
  let time = utcMillis(year, month, day, hour, minute, second, millis);
  if (time === null) return null;
  if (zone !== undefined && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
    time -= zone.startsWith("-") ? -offset : offset;
  }
  return { date: new Date(time), dateOnly: false };
}

/**
 * A date field. Null when the key is absent, null or blank (nothing to show); otherwise always an
 * `OkfDate`, `valid: false` for a value that is not an accepted date (a number, a list, `soon`).
 */
export function parseOkfDate(value: unknown): OkfDate | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const raw = displayText(value, 80);
  if (typeof value !== "string") return { raw, valid: false, date: null, dateOnly: false };
  const parsed = parseDateText(value);
  if (parsed === null) return { raw, valid: false, date: null, dateOnly: false };
  return { raw, valid: true, date: parsed.date, dateOnly: parsed.dateOnly };
}

function utcDay(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

export type Staleness =
  | { readonly state: "none" }
  | { readonly state: "invalid"; readonly raw: string }
  | {
      readonly state: "upcoming";
      readonly due: OkfDate;
      /** Whole UTC days from today to the due date; 0 when it is due today. */
      readonly daysUntil: number;
    }
  | {
      readonly state: "stale";
      readonly due: OkfDate;
      /** Whole UTC days since the due date; 0 only for a time earlier today. */
      readonly daysOverdue: number;
    };

/**
 * Whether `stale_after` has passed at `now`. No field, or an unusable `now`, is `none`. An
 * unparsable field is `invalid` (never a warning). A date alone is stale from the start of the next
 * UTC day; a date with a time is stale once that instant has passed.
 */
export function staleness(meta: Pick<OkfMeta, "staleAfter">, now: Date): Staleness {
  const field = meta.staleAfter;
  if (field === null || Number.isNaN(now.getTime())) return { state: "none" };
  if (!field.valid || field.date === null) return { state: "invalid", raw: field.raw };
  const staleFrom = field.date.getTime() + (field.dateOnly ? DAY_MS : 0);
  const days = utcDay(now) - utcDay(field.date);
  if (now.getTime() > staleFrom) {
    return { state: "stale", due: field, daysOverdue: Math.max(0, days) };
  }
  return { state: "upcoming", due: field, daysUntil: Math.max(0, -days) };
}

// --- notices --------------------------------------------------------------------------------

export type StatusNotice = "deprecated" | "draft";

/** `deprecated` or `draft` (case and surrounding whitespace ignored), else null. */
export function statusNotice(status: string | null | undefined): StatusNotice | null {
  if (typeof status !== "string") return null;
  const key = status.trim().toLowerCase();
  return key === "deprecated" || key === "draft" ? key : null;
}

export type OkfNotice =
  | { readonly kind: "deprecated" }
  | { readonly kind: "draft" }
  | { readonly kind: "stale"; readonly due: OkfDate; readonly daysOverdue: number };

/** The notices a document gets, in the order shown: status first, then staleness. */
export function buildNotices(meta: OkfMeta, now: Date): OkfNotice[] {
  const notices: OkfNotice[] = [];
  const status = statusNotice(meta.status);
  if (status !== null) notices.push({ kind: status });
  const stale = staleness(meta, now);
  if (stale.state === "stale") {
    notices.push({ kind: "stale", due: stale.due, daysOverdue: stale.daysOverdue });
  }
  return notices;
}

// --- the view model -------------------------------------------------------------------------

/** A frontmatter key the card does not know, with a bounded display value. */
export interface UnknownEntry {
  readonly key: string;
  readonly value: DisplayValue;
}

export interface OkfMeta {
  /** Verbatim (case kept), cleaned for display. */
  readonly type: string | null;
  readonly status: string | null;
  readonly tags: readonly string[];
  /**
   * What a filter link must carry, as stored (not cleaned): the table of contents groups and
   * matches documents by the exact stored value, so a link built from the cleaned text of a value
   * with zero-width marks, double spaces or over 120 characters would point at another group or
   * at none. Null when the stored value cannot be a filter value at all (over `MAX_FILTER_CHARS`
   * characters, empty): then there is no group to link to. `tagFilters[i]` belongs to `tags[i]`.
   */
  readonly typeFilter: string | null;
  readonly statusFilter: string | null;
  readonly tagFilters: readonly (string | null)[];
  readonly tagsOmitted: number;
  readonly description: string | null;
  readonly resource: OkfRefs;
  readonly sources: OkfRefs;
  readonly generated: OkfDate | null;
  readonly verified: OkfDate | null;
  readonly staleAfter: OkfDate | null;
  readonly unknown: readonly UnknownEntry[];
  /** Unknown keys past `MAX_UNKNOWN`, not shown. */
  readonly unknownOmitted: number;
  /** There is something to show: a card with no rows is not worth rendering. */
  readonly hasContent: boolean;
}

export interface OkfColumns {
  readonly type: string | null;
  readonly tags: readonly string[];
  readonly status: string | null;
  readonly description: string | null;
}

/** `value` as a filter value of the table of contents, exactly as stored, or null if it cannot be one. */
function filterValue(value: string): string | null {
  return normalizeFilterValues([value])?.[0] ?? null;
}

const NO_REFS: OkfRefs = { items: [], omitted: 0 };

function allStrings(list: readonly unknown[]): boolean {
  return list.every((item) => typeof item === "string");
}

/**
 * The metadata of a document: the stored columns (`type`, `tags`, `status`, `description`, as the
 * sync derived them and the filters use them) plus the stored frontmatter (all keys as authored).
 * Never throws; `frontmatter` that is not an object is empty.
 */
export function buildOkfMeta(frontmatter: unknown, columns: OkfColumns): OkfMeta {
  const fm: Record<string, unknown> = isObject(frontmatter) ? frontmatter : {};
  const consumed = new Set<string>();

  const textField = (
    key: string,
    column: string | null,
  ): { readonly text: string | null; readonly source: string | null } => {
    const fromFm = nonBlankString(own(fm, key));
    const source = column !== null && column.trim() !== "" ? column : fromFm;
    // A blank or null value has nothing to show; any other non-string value is listed instead.
    const authored = own(fm, key);
    if (authored === null || typeof authored === "string") consumed.add(key);
    if (source === null) return { text: null, source: null };
    const { text } = cleanText(source, MAX_TEXT, key === "description");
    return text === "" ? { text: null, source: null } : { text, source };
  };

  const { text: type, source: typeSource } = textField("type", columns.type);
  const { text: status, source: statusSource } = textField("status", columns.status);
  const { text: description } = textField("description", columns.description);

  // `tags` is shown from the column (what the filters use); the key is consumed when its value is
  // a string or a list of strings, else it is listed with the unknown keys so nothing is hidden.
  const rawTags = own(fm, "tags");
  if (
    rawTags === null ||
    typeof rawTags === "string" ||
    (Array.isArray(rawTags) && allStrings(rawTags as unknown[]))
  ) {
    consumed.add("tags");
  }
  const columnTags: readonly unknown[] = Array.isArray(columns.tags) ? columns.tags : [];
  const tagList: string[] = [];
  const tagFilterList: (string | null)[] = [];
  for (const tag of columnTags) {
    if (typeof tag !== "string") continue;
    const text = shortText(tag, MAX_KEY);
    if (text === "") continue;
    tagList.push(text);
    tagFilterList.push(filterValue(tag));
  }
  const tags = tagList.slice(0, MAX_UNKNOWN);
  const tagFilters = tagFilterList.slice(0, MAX_UNKNOWN);

  const refs = (key: string): OkfRefs => {
    const value = own(fm, key);
    if (value === undefined) return NO_REFS;
    consumed.add(key);
    return parseRefs(value);
  };
  const resource = refs("resource");
  const sources = refs("sources");

  const date = (key: string): OkfDate | null => {
    const value = own(fm, key);
    if (value !== undefined) consumed.add(key);
    return parseOkfDate(value);
  };
  const generated = date("generated");
  const verified = date("verified");
  const staleAfter = date("stale_after");

  if (nonBlankString(own(fm, "title")) !== null) consumed.add("title");
  const version = own(fm, "okf_version");
  if (typeof version === "string" || typeof version === "number") consumed.add("okf_version");

  const unknown: UnknownEntry[] = [];
  let unknownOmitted = 0;
  for (const key of Object.keys(fm)) {
    if (consumed.has(key)) continue;
    if (unknown.length >= MAX_UNKNOWN) {
      unknownOmitted += 1;
      continue;
    }
    unknown.push({ key: shortText(key), value: toDisplayValue(fm[key]) });
  }

  const hasContent =
    type !== null ||
    status !== null ||
    tags.length > 0 ||
    description !== null ||
    resource.items.length > 0 ||
    sources.items.length > 0 ||
    generated !== null ||
    verified !== null ||
    staleAfter !== null ||
    unknown.length > 0;

  return {
    type,
    status,
    tags,
    typeFilter: typeSource === null ? null : filterValue(typeSource),
    statusFilter: statusSource === null ? null : filterValue(statusSource),
    tagFilters,
    tagsOmitted: Math.max(0, tagList.length - tags.length),
    description,
    resource,
    sources,
    generated,
    verified,
    staleAfter,
    unknown,
    unknownOmitted,
    hasContent,
  };
}
