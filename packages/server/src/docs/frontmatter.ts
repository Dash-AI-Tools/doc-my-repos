import { parseDocument } from "yaml";

/** A value that survives a round trip through Postgres JSONB. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type FrontmatterData = { readonly [key: string]: JsonValue };

export interface ParsedFrontmatter {
  /** Every top-level key as authored (order and case kept), JSON-safe. Empty when there is none. */
  readonly frontmatter: FrontmatterData;
  /** The Markdown after the frontmatter block, or the whole input when there is no block. */
  readonly body: string;
  /** `frontmatter.type` when it is a non-blank string, verbatim; otherwise null. */
  readonly type: string | null;
  /** Fixed-text diagnostics, never quoting the document. For `sync_runs.results`. */
  readonly warnings: readonly string[];
}

/** Larger blocks are not parsed; far above any real frontmatter. */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

/** Nesting limit for the converted value. */
export const MAX_FRONTMATTER_DEPTH = 32;

/** Total values (scalars, arrays and objects) kept; stops alias expansion from multiplying. */
export const MAX_FRONTMATTER_NODES = 10_000;

/** Aliases are rare in frontmatter; a low cap rules out alias-expansion bombs. */
const MAX_YAML_ALIASES = 20;

const NUL = /\u0000/g;
const OPEN_FENCE = /^---[ \t]*\r?\n/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*\r?$/m;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CR_ONLY_FENCE = /^---[ \t]*\r(?!\n)/;

/** Postgres text and JSONB reject U+0000. */
export function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(NUL, "") : value;
}

/** Replaces lone UTF-16 surrogates with U+FFFD; Postgres JSONB rejects them. */
export function toWellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, "\ufffd");
}

/** NUL removed and lone surrogates replaced: safe for Postgres text and JSONB. */
function clean(value: string): string {
  return toWellFormed(stripNul(value));
}

export type Sanitized =
  { ok: true; value: FrontmatterData; notes: Set<string> } | { ok: false; reason: string };

/**
 * Copies the converted YAML into plain JSON values: NULs stripped and lone surrogates replaced
 * in keys and strings, non-finite numbers, bigints, dates and other exotic values made safe.
 * Fails on a cycle, excess depth or excess size. Iterative bookkeeping is not needed: recursion
 * is bounded by `MAX_FRONTMATTER_DEPTH`. Exported for tests: the `core` schema never yields
 * bigints or dates, so some branches are unreachable through `parseFrontmatter`.
 */
export function sanitizeFrontmatter(root: Record<string, unknown>): Sanitized {
  const notes = new Set<string>();
  const ancestors = new Set<object>();
  let nodes = 0;
  let failure: string | null = null;

  const walk = (value: unknown, depth: number): JsonValue => {
    if (failure !== null) return null;
    if (++nodes > MAX_FRONTMATTER_NODES) {
      failure = "frontmatter has too many values";
      return null;
    }
    switch (typeof value) {
      case "string":
        return clean(value);
      case "boolean":
        return value;
      case "number":
        if (Number.isFinite(value)) return value;
        notes.add("a non-finite number was replaced with null");
        return null;
      case "bigint":
        return value.toString();
      case "object":
        break;
      default:
        notes.add("an unsupported value was replaced with null");
        return null;
    }
    if (value === null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const isArray = Array.isArray(value);
    if (!isArray && Object.getPrototypeOf(value) !== Object.prototype) {
      notes.add("an unsupported value was replaced with null");
      return null;
    }
    if (ancestors.has(value)) {
      failure = "frontmatter contains a self-referencing alias";
      return null;
    }
    if (depth >= MAX_FRONTMATTER_DEPTH) {
      failure = "frontmatter is nested too deeply";
      return null;
    }
    ancestors.add(value);
    let result: JsonValue;
    if (isArray) {
      result = (value as unknown[]).map((item) => walk(item, depth + 1));
    } else {
      // fromEntries defines own properties, so a `__proto__` key stays plain data.
      result = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [clean(key), walk(child, depth + 1)]),
      );
    }
    ancestors.delete(value);
    return result;
  };

  const value = walk(root, 0) as FrontmatterData;
  return failure === null ? { ok: true, value, notes } : { ok: false, reason: failure };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function none(body: string, warnings: string[] = []): ParsedFrontmatter {
  return { frontmatter: {}, body, type: null, warnings };
}

/**
 * `fullText` is returned as the body whenever the block cannot be used as metadata, so no prose
 * is lost; `body` (the text after the block) is returned only when the block was consumed.
 */
function parseBlock(block: string, fullText: string, body: string): ParsedFrontmatter {
  if (Buffer.byteLength(block, "utf8") > MAX_FRONTMATTER_BYTES) {
    return none(fullText, [
      `frontmatter ignored: block is larger than ${MAX_FRONTMATTER_BYTES} bytes`,
    ]);
  }

  // YAML 1.2 core schema: no timestamps, merge keys or custom tags. `logLevel: "error"` stops
  // `yaml` from calling `process.emitWarning` with document text. Duplicate keys are tolerated
  // (the last one wins) because a broken block would drop all of the document's metadata.
  const doc = parseDocument(block, {
    version: "1.2",
    schema: "core",
    uniqueKeys: false,
    logLevel: "error",
  });
  if (doc.errors.length > 0) {
    const resource = doc.errors.some((e) => e.code === "RESOURCE_EXHAUSTION");
    return none(fullText, [
      resource ? "frontmatter ignored: nested too deeply" : "frontmatter ignored: not valid YAML",
    ]);
  }

  const warnings: string[] = [];
  if (doc.warnings.length > 0) warnings.push("frontmatter contains unsupported YAML tags");

  let raw: unknown;
  try {
    raw = doc.contents === null ? {} : doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch {
    // Alias limit or similar; the message may quote the document, so it is dropped.
    return none(fullText, [
      ...warnings,
      "frontmatter ignored: too many aliases or not convertible",
    ]);
  }

  if (!isPlainObject(raw)) {
    return none(fullText, [...warnings, "frontmatter ignored: not a key/value mapping"]);
  }

  const result = sanitizeFrontmatter(raw);
  if (!result.ok) return none(fullText, [...warnings, `frontmatter ignored: ${result.reason}`]);
  warnings.push(...[...result.notes].map((note) => `frontmatter: ${note}`));

  let type: string | null = null;
  const declared = result.value.type;
  if (typeof declared === "string") {
    type = declared.trim() === "" ? null : declared;
  } else if (declared !== undefined && declared !== null) {
    // Spec is silent on a non-string `type`. Keep it in `frontmatter`, but do not coerce it
    // into the free-form string facet.
    warnings.push("frontmatter: `type` is not a string and was not used as the document type");
  }

  return { frontmatter: result.value, body, type, warnings };
}

/**
 * Splits leading YAML frontmatter from a Markdown file and converts it to JSON-safe data.
 * Never throws. A block must open with `---` on the first line (after an optional BOM) and
 * close with `---` or `...` on a line of its own. The block is removed from the body only when
 * it parsed as a key/value mapping (or is empty or comment-only). In every other case (no
 * closing fence, invalid YAML, a non-mapping, or over the size, depth, node or alias caps) the
 * document is still synced as having no metadata: the body is the whole input, so no prose is
 * lost, and a warning is returned. A `---` ... `---` span of ordinary prose is therefore kept.
 * CR-only (classic Mac) line endings are not recognized as fences; this is reported as a
 * warning. NULs are stripped and lone surrogates replaced by U+FFFD everywhere, since Postgres
 * text and JSONB reject both.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  let text = clean(source);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const open = OPEN_FENCE.exec(text);
  if (open === null) {
    return CR_ONLY_FENCE.test(text)
      ? none(text, ["frontmatter ignored: CR-only line endings are not supported"])
      : none(text);
  }

  const rest = text.slice(open[0].length);
  const close = CLOSE_FENCE.exec(rest);
  if (close === null) {
    return none(text, ["frontmatter ignored: opening --- has no closing fence"]);
  }

  const block = rest.slice(0, close.index);
  const afterFence = rest.slice(close.index + close[0].length);
  const body = afterFence.replace(/^\r?\n/, "");
  return parseBlock(block, text, body);
}
