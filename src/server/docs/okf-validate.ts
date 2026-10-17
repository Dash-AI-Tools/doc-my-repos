import { cleanText, parseOkfDate, staleness, statusNotice } from "../../lib/okf-meta";
import { MAX_FACET_CHARS, MAX_TAGS } from "../sync/document-record";
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS, extractMetadata } from "./extract";
import { parseFrontmatter, stripNul, toWellFormed, type JsonValue } from "./frontmatter";
import { reservedKind } from "./okf";

/**
 * Checks a draft Markdown document against OKF and against the portal's own rules (mcp-agent-access
 * spec `okf-authoring`, design decision 7). Pure: no database, no network; nothing is stored or
 * logged. It lives beside the sync's frontmatter parser and OKF rules because it must agree with
 * them: it uses the same `parseFrontmatter` (so the same size, depth, node and alias caps), the same
 * `extractMetadata` for headings, the same `MAX_FACET_CHARS` and `MAX_TAGS`, and the same
 * `reservedKind` / date rules. A document with no `error` finding is one the sync stores with a
 * `type` and shows as an OKF concept (`okf-validate.agreement.test.ts` holds that).
 *
 * Findings carry a fixed `code`, a severity, and a fixed `message` per code (and per key for
 * `field-shape`). Nothing from the document is echoed except an `excerpt` of at most 80 characters
 * cleaned of control and direction-override characters, and, for a new type, tag or status, the
 * repository's own existing values in `suggestion` (cleaned and clipped, labelled as vocabulary).
 *
 * Errors: `frontmatter-missing`, `frontmatter-unclosed`, `frontmatter-invalid`, `type-missing`,
 * `type-not-text`, `type-too-long`, `field-shape`, `content-too-large`. Warnings: `date-invalid`,
 * `stale-past`, `title-long`, `description-long`, `description-missing`, `h1-missing`,
 * `h1-multiple`, `link-broken`. Info: `type-new`, `tag-new`, `status-new`, `status-draft`,
 * `status-deprecated`, `reserved-typed`.
 */

/** Content over this many bytes (the sync's own per-file cap) is not validated. */
export const MAX_CONTENT_BYTES = 256 * 1024;

export type FindingSeverity = "error" | "warning" | "info";

export type FindingCode =
  | "content-too-large"
  | "frontmatter-missing"
  | "frontmatter-unclosed"
  | "frontmatter-invalid"
  | "type-missing"
  | "type-not-text"
  | "type-too-long"
  | "field-shape"
  | "date-invalid"
  | "stale-past"
  | "title-long"
  | "description-long"
  | "description-missing"
  | "h1-missing"
  | "h1-multiple"
  | "link-broken"
  | "type-new"
  | "tag-new"
  | "status-new"
  | "status-draft"
  | "status-deprecated"
  | "reserved-typed";

export interface Finding {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  /** Fixed text for the code (and key). Never quotes the document. */
  readonly message: string;
  /** The frontmatter key the finding is about, when it is about one. */
  readonly key?: string;
  /** 1-based line in the validated content, when one applies. */
  readonly line?: number;
  /** A short cleaned excerpt of the offending value (at most 80 characters). */
  readonly excerpt?: string;
  /** What to do, or the repository's existing vocabulary. */
  readonly suggestion?: string;
}

/** The values a repository's documents already use. Empty or missing lists are not compared. */
export interface Vocabulary {
  readonly types?: readonly string[];
  readonly tags?: readonly string[];
  readonly statuses?: readonly string[];
}

export interface ValidateOptions {
  /** Repo-relative path the document will have (`docs/guides/setup.md`). */
  readonly path?: string;
  readonly vocabulary?: Vocabulary;
  /** Repo-relative paths of the repository's synced documents, for link checking. */
  readonly knownPaths?: ReadonlySet<string>;
  /**
   * The repository's docs folder (`docs`). Only links that resolve inside it are checked: the
   * portal syncs every document there, but a link to a README or a file elsewhere in the repository
   * becomes a GitHub link, which this check cannot judge. Default: the first folder of `path`.
   */
  readonly docsFolder?: string | null;
  /** The clock for `stale_after`. Default: now. */
  readonly now?: Date;
}

export interface ValidationResult {
  /** True when there is no `error` finding. */
  readonly valid: boolean;
  readonly findings: readonly Finding[];
}

const EXCERPT_CHARS = 80;
const MAX_NEW_VALUE_FINDINGS = 10;
const MAX_LISTED_VOCABULARY = 10;
const MAX_LINK_FINDINGS = 25;

const FRONTMATTER_SUGGESTION =
  "Start the file with:\n---\ntype: Concept\ndescription: One sentence about this document.\n---";

/** Fixed message per code; `field-shape` has one per key (see `FIELD_SHAPE_MESSAGES`). */
const MESSAGES: Readonly<Record<Exclude<FindingCode, "field-shape">, string>> = {
  "content-too-large": "The content is larger than 256 KB, so nothing was validated.",
  "frontmatter-missing":
    "The document has no frontmatter. An OKF document starts with a block between two --- lines that declares its type.",
  "frontmatter-unclosed":
    "The frontmatter block is opened with --- but never closed with a --- line, so the portal ignores it.",
  "frontmatter-invalid":
    "The frontmatter is not a valid YAML mapping, or it is too large or too deeply nested, so the portal ignores it.",
  "type-missing": "The frontmatter has no type, which every OKF concept document needs.",
  "type-not-text": "The type must be text, for example type: Runbook.",
  "type-too-long": `The type is longer than ${MAX_FACET_CHARS} characters, so the portal does not use it.`,
  "date-invalid": "A date field is not a valid date. Use YYYY-MM-DD, or an ISO date with a time.",
  "stale-past": "stale_after has already passed, so the portal shows the document as stale.",
  "title-long": `The title is longer than ${MAX_TITLE_CHARS} characters, so the portal cuts it.`,
  "description-long": `The description is longer than ${MAX_DESCRIPTION_CHARS} characters, so the portal cuts it.`,
  "description-missing":
    "The frontmatter has no description. One sentence helps search and the agents that read it.",
  "h1-missing": "The document has no level-1 heading (a line starting with #).",
  "h1-multiple": "The document has more than one level-1 heading.",
  "link-broken":
    "A relative link points to a document that is not among the repository's synced docs.",
  "type-new": "This type is not used by any other document of the repository.",
  "tag-new": "This tag is not used by any other document of the repository.",
  "status-new": "This status is not used by any other document of the repository.",
  "status-draft": "The status is draft; the portal marks the document as a draft.",
  "status-deprecated": "The status is deprecated; the portal marks the document as deprecated.",
  "reserved-typed":
    "index.md and log.md are reserved files, not concepts. They should not declare a type.",
};

const FIELD_SHAPE_MESSAGES: Readonly<Record<string, string>> = {
  tags: `tags must be a list of text values (at most ${MAX_TAGS}, each at most ${MAX_FACET_CHARS} characters).`,
  status: `status must be one text value of at most ${MAX_FACET_CHARS} characters.`,
  sources: "sources must be text, a mapping such as {title, url}, or a list of those.",
};

const SEVERITY: Readonly<Record<FindingCode, FindingSeverity>> = {
  "content-too-large": "error",
  "frontmatter-missing": "error",
  "frontmatter-unclosed": "error",
  "frontmatter-invalid": "error",
  "type-missing": "error",
  "type-not-text": "error",
  "type-too-long": "error",
  "field-shape": "error",
  "date-invalid": "warning",
  "stale-past": "warning",
  "title-long": "warning",
  "description-long": "warning",
  "description-missing": "warning",
  "h1-missing": "warning",
  "h1-multiple": "warning",
  "link-broken": "warning",
  "type-new": "info",
  "tag-new": "info",
  "status-new": "info",
  "status-draft": "info",
  "status-deprecated": "info",
  "reserved-typed": "info",
};

const DATE_KEYS = ["generated", "verified", "stale_after"] as const;

const isText = (value: unknown): value is string => typeof value === "string";
const isBlank = (value: string): boolean => value.trim() === "";
const clip = (value: string, max = EXCERPT_CHARS): string => cleanText(value, max).text;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Lines

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The 1-based line of a top-level `key:` inside the frontmatter block, or undefined. `lines` are
 * the lines of the cleaned content; the block opens on line 1.
 */
function frontmatterKeyLine(lines: readonly string[], key: string): number | undefined {
  const pattern = new RegExp(`^["']?${escapeRegExp(key)}["']?[ \\t]*:`);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) return undefined;
    if (pattern.test(line)) return i + 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Body scan: level-1 headings and relative links, by line, outside fenced code

interface BodyScan {
  readonly h1Lines: number[];
  /** Text of the ATX level-1 headings, as written, in order (setext headings are not included). */
  readonly h1Texts: string[];
  readonly links: { line: number; target: string }[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_H1 = /^ {0,3}#(?!#)(?:[ \t]|$)/;
const SETEXT_H1_UNDERLINE = /^ {0,3}=+[ \t]*$/;
const INLINE_LINK =
  /(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/;
const CODE_SPAN = /(`+)[^`\n]*?\1/g;

/** Scans the lines of `body`; `offset` is the number of lines before it in the whole content. */
function scanBody(body: string, offset: number): BodyScan {
  const h1Lines: number[] = [];
  const h1Texts: string[] = [];
  const links: { line: number; target: string }[] = [];
  let fence: { char: string; length: number } | null = null;
  const lines = body.split(/\r\n?|\n/);
  let previous = "";
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const lineNumber = offset + i + 1;
    const open = FENCE.exec(raw);
    if (fence !== null) {
      const closing = FENCE.exec(raw);
      if (
        closing !== null &&
        (closing[1] as string)[0] === fence.char &&
        (closing[1] as string).length >= fence.length &&
        raw.trim() === closing[1]
      ) {
        fence = null;
      }
      previous = "";
      continue;
    }
    if (open !== null) {
      fence = { char: (open[1] as string)[0] as string, length: (open[1] as string).length };
      previous = "";
      continue;
    }
    if (ATX_H1.test(raw)) {
      h1Lines.push(lineNumber);
      h1Texts.push(raw.replace(/^ {0,3}#[ \t]*/, "").replace(/[ \t]+#+[ \t]*$/, ""));
    } else if (
      SETEXT_H1_UNDERLINE.test(raw) &&
      previous.trim() !== "" &&
      !/^ {4,}/.test(previous)
    ) {
      h1Lines.push(lineNumber - 1);
    }
    previous = raw;

    const text = raw.replace(CODE_SPAN, (span) => " ".repeat(span.length));
    for (const match of text.matchAll(INLINE_LINK)) {
      if (match[1] === "!") continue; // an image points at a file, not a document
      links.push({ line: lineNumber, target: match[2] as string });
    }
    const definition = REFERENCE_DEFINITION.exec(text);
    if (definition !== null) links.push({ line: lineNumber, target: definition[1] as string });
  }
  return { h1Lines, h1Texts, links };
}

// ---------------------------------------------------------------------------------------------
// Relative links

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Lower-cases a trailing `.MD` / `.MDX`, which the sync accepts in any case. */
function normalizeExtension(path: string): string {
  return path.replace(/\.(mdx?)$/i, (ext) => ext.toLowerCase());
}

/**
 * The document paths a relative link could mean, or null when the link is not one to check: an
 * anchor, an absolute URL or site-root path, a link that leaves the repository, or a file that is
 * not a document (an image, a spec).
 */
function linkCandidates(target: string, fromPath: string): string[] | null {
  let text = target.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();
  if (text === "" || text.startsWith("#") || text.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  const cut = text.search(/[?#]/);
  if (cut !== -1) text = text.slice(0, cut);
  if (text === "") return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the text as written.
  }
  const directory = text.endsWith("/");
  const segments = dirname(fromPath) === "" ? [] : dirname(fromPath).split("/");
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  if (segments.length === 0) return null;
  const resolved = segments.join("/");
  const last = segments.at(-1) as string;
  if (!directory && /\.mdx?$/i.test(last)) return [normalizeExtension(resolved)];
  if (!directory && last.includes(".") && !last.startsWith(".")) return null;
  return [`${resolved}.md`, `${resolved}.mdx`, `${resolved}/index.md`, `${resolved}/index.mdx`];
}

function brokenLinks(
  links: readonly { line: number; target: string }[],
  fromPath: string,
  known: ReadonlySet<string>,
  docsFolder: string,
): { line: number; target: string }[] {
  const normalized = new Set(Array.from(known, normalizeExtension));
  const prefix = `${docsFolder.replace(/^\/+|\/+$/g, "").toLowerCase()}/`;
  const broken: { line: number; target: string }[] = [];
  for (const link of links) {
    const candidates = linkCandidates(link.target, fromPath);
    if (candidates === null) continue;
    // Outside the docs folder the file may exist in the repository without being synced.
    if (!(candidates[0] as string).toLowerCase().startsWith(prefix)) continue;
    if (candidates.some((c) => normalized.has(c))) continue;
    broken.push(link);
  }
  return broken;
}

// ---------------------------------------------------------------------------------------------
// The validation

/** True for a source entry the portal can show: text, or a mapping (the sync's `parseRefs`). */
function usableSource(entry: JsonValue): boolean {
  return isText(entry) || isPlainObject(entry);
}

function sourcesUsable(value: JsonValue): boolean {
  if (isText(value) || isPlainObject(value)) return true;
  return Array.isArray(value) && value.every(usableSource);
}

function tagsUsable(value: JsonValue): boolean {
  if (isText(value)) return value.length <= MAX_FACET_CHARS;
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_TAGS) return false;
  return value.every((tag) => isText(tag) && tag.length <= MAX_FACET_CHARS);
}

function listed(values: readonly string[]): string {
  const shown = values.slice(0, MAX_LISTED_VOCABULARY).map((v) => clip(v, 40));
  const more = values.length > shown.length ? `, and ${values.length - shown.length} more` : "";
  return shown.join(", ") + more;
}

export function validateOkfDocument(
  content: string,
  options: ValidateOptions = {},
): ValidationResult {
  const findings: Finding[] = [];
  const add = (
    code: FindingCode,
    extra: Pick<Finding, "key" | "line" | "excerpt" | "suggestion"> = {},
  ): void => {
    const message =
      code === "field-shape"
        ? (FIELD_SHAPE_MESSAGES[extra.key ?? ""] ?? "A frontmatter field has an unusable shape.")
        : MESSAGES[code];
    findings.push({ code, severity: SEVERITY[code], message, ...extra });
  };
  const finish = (): ValidationResult => ({
    valid: !findings.some((f) => f.severity === "error"),
    findings,
  });

  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    add("content-too-large");
    return finish();
  }

  const path = options.path ?? "";
  const reserved = path === "" ? null : reservedKind(path);
  const cleaned = toWellFormed(stripNul(content)).replace(/^﻿/, "");
  const lines = cleaned.split(/\r?\n/);
  const parsed = parseFrontmatter(content);
  const ignoredWarning = parsed.warnings.find((w) => w.startsWith("frontmatter ignored:"));
  const hasOpenFence = /^---[ \t]*\r?\n/.test(cleaned);

  let frontmatterError = false;
  if (!hasOpenFence && ignoredWarning === undefined) {
    if (reserved === null) {
      add("frontmatter-missing", { line: 1, suggestion: FRONTMATTER_SUGGESTION });
      frontmatterError = true;
    }
  } else if (ignoredWarning !== undefined) {
    // The block exists but the portal cannot use it.
    add(
      ignoredWarning.includes("no closing fence") ? "frontmatter-unclosed" : "frontmatter-invalid",
      {
        line: 1,
        ...(ignoredWarning.includes("CR-only")
          ? { suggestion: "Save the file with LF or CRLF line endings." }
          : {}),
      },
    );
    frontmatterError = true;
  }

  const fm = parsed.frontmatter;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(fm, key);

  if (!frontmatterError) {
    // --- type
    if (reserved !== null) {
      if (has("type"))
        add("reserved-typed", { key: "type", line: frontmatterKeyLine(lines, "type") });
    } else {
      const declared = fm.type;
      const line = frontmatterKeyLine(lines, "type");
      if (declared === undefined || declared === null || (isText(declared) && isBlank(declared))) {
        add("type-missing", { key: "type", line: line ?? 1 });
      } else if (!isText(declared)) {
        add("type-not-text", { key: "type", line });
      } else if (declared.length > MAX_FACET_CHARS) {
        add("type-too-long", { key: "type", line });
      }
    }

    // --- shapes the sync would drop
    if (has("tags") && fm.tags !== null && !tagsUsable(fm.tags as JsonValue)) {
      add("field-shape", { key: "tags", line: frontmatterKeyLine(lines, "tags") });
    }
    if (
      has("status") &&
      fm.status !== null &&
      (!isText(fm.status) || fm.status.length > MAX_FACET_CHARS)
    ) {
      add("field-shape", { key: "status", line: frontmatterKeyLine(lines, "status") });
    }
    if (has("sources") && fm.sources !== null && !sourcesUsable(fm.sources as JsonValue)) {
      add("field-shape", { key: "sources", line: frontmatterKeyLine(lines, "sources") });
    }

    // --- dates
    const now = options.now ?? new Date();
    for (const key of DATE_KEYS) {
      const date = parseOkfDate(fm[key]);
      if (date !== null && !date.valid) {
        add("date-invalid", { key, line: frontmatterKeyLine(lines, key), excerpt: clip(date.raw) });
      }
    }
    if (staleness({ staleAfter: parseOkfDate(fm.stale_after) }, now).state === "stale") {
      add("stale-past", { key: "stale_after", line: frontmatterKeyLine(lines, "stale_after") });
    }

    // --- title and description
    if (isText(fm.title) && [...fm.title.trim()].length > MAX_TITLE_CHARS) {
      add("title-long", { key: "title", line: frontmatterKeyLine(lines, "title") });
    }
    const description = fm.description;
    if (!isText(description) || isBlank(description)) {
      add("description-missing", { key: "description" });
    } else if ([...description.trim()].length > MAX_DESCRIPTION_CHARS) {
      add("description-long", {
        key: "description",
        line: frontmatterKeyLine(lines, "description"),
      });
    }

    // --- status notices
    const notice = isText(fm.status) ? statusNotice(fm.status) : null;
    if (notice === "draft")
      add("status-draft", { key: "status", line: frontmatterKeyLine(lines, "status") });
    if (notice === "deprecated") {
      add("status-deprecated", { key: "status", line: frontmatterKeyLine(lines, "status") });
    }

    // --- the repository's own vocabulary
    const vocabulary = options.vocabulary;
    if (vocabulary !== undefined) {
      const type = isText(fm.type) && !isBlank(fm.type) ? fm.type : null;
      if (type !== null && reserved === null && (vocabulary.types?.length ?? 0) > 0) {
        if (!(vocabulary.types as readonly string[]).includes(type)) {
          add("type-new", {
            key: "type",
            line: frontmatterKeyLine(lines, "type"),
            excerpt: clip(type),
            suggestion: `Types in use: ${listed(vocabulary.types as readonly string[])}`,
          });
        }
      }
      const tags = isText(fm.tags)
        ? [fm.tags]
        : Array.isArray(fm.tags)
          ? fm.tags.filter(isText)
          : [];
      if ((vocabulary.tags?.length ?? 0) > 0) {
        const known = new Set(vocabulary.tags);
        const fresh = [...new Set(tags)].filter((t) => !isBlank(t) && !known.has(t));
        for (const tag of fresh.slice(0, MAX_NEW_VALUE_FINDINGS)) {
          add("tag-new", {
            key: "tags",
            line: frontmatterKeyLine(lines, "tags"),
            excerpt: clip(tag),
            suggestion: `Tags in use: ${listed(vocabulary.tags as readonly string[])}`,
          });
        }
      }
      if (
        isText(fm.status) &&
        !isBlank(fm.status) &&
        (vocabulary.statuses?.length ?? 0) > 0 &&
        !(vocabulary.statuses as readonly string[]).includes(fm.status)
      ) {
        add("status-new", {
          key: "status",
          line: frontmatterKeyLine(lines, "status"),
          excerpt: clip(fm.status),
          suggestion: `Statuses in use: ${listed(vocabulary.statuses as readonly string[])}`,
        });
      }
    }
  }

  // --- body: headings and links (skipped when the frontmatter itself is broken, because the
  // portal then treats the whole file as body and every finding below would be noise)
  if (!frontmatterError) {
    const consumed = cleaned.length - parsed.body.length;
    const offset = (cleaned.slice(0, Math.max(0, consumed)).match(/\n/g) ?? []).length;
    const scan = scanBody(parsed.body, offset);
    const meta = extractMetadata({
      body: parsed.body,
      frontmatter: fm,
      path: path || "document.md",
    });
    const h1Count = meta.headings.filter((h) => h.depth === 1).length;
    if (h1Count === 0) add("h1-missing");
    else if (h1Count > 1) add("h1-multiple", { line: scan.h1Lines[1] });
    // Without a title key the first heading is the title; its stored text is already clipped, so
    // the raw line is measured.
    if (!isText(fm.title) && [...(scan.h1Texts[0] ?? "")].length > MAX_TITLE_CHARS) {
      add("title-long", { line: scan.h1Lines[0] });
    }

    const folder =
      options.docsFolder ?? (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");
    if (options.knownPaths !== undefined && path !== "" && folder !== "") {
      for (const link of brokenLinks(scan.links, path, options.knownPaths, folder).slice(
        0,
        MAX_LINK_FINDINGS,
      )) {
        add("link-broken", { line: link.line, excerpt: clip(link.target) });
      }
    }
  }

  return finish();
}
