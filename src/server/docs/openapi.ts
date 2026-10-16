import { parseDocument } from "yaml";
import { DEFAULT_MAX_SPEC_BYTES } from "../config/schema";
import { stripNul, toWellFormed, type JsonValue } from "./frontmatter";

/**
 * Pure parser for OpenAPI 3.x and Swagger 2.0 description files (design decision 4). It never
 * throws and never quotes the input in its result: a rejection is a fixed reason code, so it can be
 * stored in sync warnings. The input is untrusted third-party text, so every limit is enforced
 * before anything is returned:
 *
 * - size: the UTF-8 byte length is checked before parsing (`maxBytes`, default 2 MB);
 * - YAML: 1.2 core schema (no custom tags, no merge keys, no timestamps), unique keys, and a low
 *   alias cap, so alias "bombs" (`a: &a [*b, *b]` chains) stop before they expand;
 * - structure: one iterative walk that also builds the stored copy enforces a nesting depth limit
 *   and a node limit, then the operation count is capped. A self-referencing alias is rejected by
 *   the depth limit;
 * - cleanup: NUL removed and lone surrogates replaced in every key and string, since Postgres JSONB
 *   rejects both.
 *
 * Acceptance rule: a root mapping with an `openapi` string starting `3.` or a `swagger` equal to
 * `2.0`, an `info` mapping, and `paths` (3.0 and Swagger) or `paths`, `components` or `webhooks`
 * (3.1). `$ref`s are not resolved here.
 */

export const API_SPEC_REJECTION_REASONS = [
  "too_large",
  "invalid_syntax",
  "not_a_spec",
  "unsupported_version",
  "missing_info",
  "missing_paths",
  "too_many_aliases",
  "too_deep",
  "too_many_nodes",
  "too_many_operations",
] as const;

/** Fixed code for why a candidate file was not stored. */
export type ApiSpecRejectionReason = (typeof API_SPEC_REJECTION_REASONS)[number];

export type ApiSpecFormat = "openapi" | "swagger";

/** Parsed spec value; JSON-safe, so it can go straight into a `jsonb` column. */
export type ApiSpecDocument = { readonly [key: string]: JsonValue };

export interface ParsedApiSpec {
  readonly ok: true;
  readonly format: ApiSpecFormat;
  /** `3.1.0`, or `2.0` for Swagger. */
  readonly specVersion: string;
  /** `info.title`, or the file path when it has none. */
  readonly title: string;
  /** `info.version` as text, or null. */
  readonly apiVersion: string | null;
  readonly operationCount: number;
  readonly spec: ApiSpecDocument;
}

export interface RejectedApiSpec {
  readonly ok: false;
  readonly reason: ApiSpecRejectionReason;
}

export type ApiSpecResult = ParsedApiSpec | RejectedApiSpec;

export interface ParseApiSpecOptions {
  /** Largest accepted input in bytes. Defaults to the 2 MB spec limit. */
  readonly maxBytes?: number;
}

/** Nesting limit for the stored value (real schemas rarely pass 30). */
export const MAX_API_SPEC_DEPTH = 100;
/** Total values (scalars, arrays and objects) kept; also bounds alias expansion. */
export const MAX_API_SPEC_NODES = 300_000;
/** Most operations (path + method pairs, plus webhooks) in one spec. */
export const MAX_API_SPEC_OPERATIONS = 2_000;
/** YAML alias cap; the library multiplies it by the aliased node's size, so bombs fail fast. */
const MAX_YAML_ALIASES = 100;
/** Longest title or API version kept. */
const MAX_LABEL_LENGTH = 200;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clean(value: string): string {
  return toWellFormed(stripNul(value));
}

/** Defines an own property, so a `__proto__` key stays plain data. */
function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

type CloneResult =
  { ok: true; value: JsonValue } | { ok: false; reason: "too_deep" | "too_many_nodes" };

/**
 * Copies `root` into plain JSON values with an explicit stack (no recursion, so depth cannot
 * overflow the call stack). Shared aliased nodes are copied once per use, so they count against the
 * node limit as they would when stored.
 */
function cloneBounded(root: unknown): CloneResult {
  const holder: { v: unknown } = { v: null };
  interface Frame {
    src: unknown;
    dst: object;
    key: string;
    depth: number;
  }
  const stack: Frame[] = [{ src: root, dst: holder, key: "v", depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (++nodes > MAX_API_SPEC_NODES) return { ok: false, reason: "too_many_nodes" };
    const { src, dst, key, depth } = frame;
    let out: unknown;
    if (typeof src === "string") out = clean(src);
    else if (typeof src === "boolean") out = src;
    else if (typeof src === "number") out = Number.isFinite(src) ? src : null;
    else if (typeof src === "bigint") out = src.toString();
    else if (src instanceof Date) out = Number.isNaN(src.getTime()) ? null : src.toISOString();
    else if (Array.isArray(src)) {
      if (depth >= MAX_API_SPEC_DEPTH) return { ok: false, reason: "too_deep" };
      const arr: unknown[] = new Array<unknown>(src.length).fill(null);
      out = arr;
      for (let i = src.length - 1; i >= 0; i--) {
        stack.push({ src: src[i], dst: arr, key: String(i), depth: depth + 1 });
      }
    } else if (isPlain(src)) {
      if (depth >= MAX_API_SPEC_DEPTH) return { ok: false, reason: "too_deep" };
      const obj: Plain = {};
      out = obj;
      for (const [k, child] of Object.entries(src)) {
        const cleanKey = clean(k);
        put(obj, cleanKey, null); // fixes key order; the child overwrites it when popped
        stack.push({ src: child, dst: obj, key: cleanKey, depth: depth + 1 });
      }
    } else out = null;
    put(dst, key, out);
  }
  return { ok: true, value: holder.v as JsonValue };
}

function countOperations(spec: Plain): number {
  let count = 0;
  const countItems = (items: unknown) => {
    if (!isPlain(items)) return;
    for (const item of Object.values(items)) {
      if (!isPlain(item)) continue;
      for (const method of HTTP_METHODS) if (isPlain(item[method])) count++;
    }
  };
  countItems(spec.paths);
  countItems(spec.webhooks);
  return count;
}

function label(value: unknown): string | null {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, MAX_LABEL_LENGTH);
}

type ParseOutcome = { ok: true; value: unknown } | { ok: false; reason: ApiSpecRejectionReason };

function parseJson(text: string): ParseOutcome {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: error instanceof RangeError ? "too_deep" : "invalid_syntax" };
  }
}

function parseYaml(text: string): ParseOutcome {
  try {
    const doc = parseDocument(text, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      logLevel: "error",
    });
    if (doc.errors.length > 0) {
      const exhausted = doc.errors.some((e) => e.code === "RESOURCE_EXHAUSTION");
      return { ok: false, reason: exhausted ? "too_deep" : "invalid_syntax" };
    }
    // `toJS` throws when aliases would expand past the cap (message may quote input: dropped).
    try {
      return { ok: true, value: doc.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown };
    } catch (error) {
      if (error instanceof RangeError) return { ok: false, reason: "too_deep" };
      return { ok: false, reason: "too_many_aliases" };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof RangeError ? "too_deep" : "invalid_syntax" };
  }
}

function reject(reason: ApiSpecRejectionReason): RejectedApiSpec {
  return { ok: false, reason };
}

/**
 * Parses and validates one candidate file. `path` picks the syntax (`.json` is JSON, anything else
 * YAML, which also reads JSON) and is the title fallback.
 */
export function parseApiSpec(
  text: string,
  path: string,
  options: ParseApiSpecOptions = {},
): ApiSpecResult {
  if (typeof text !== "string") return reject("invalid_syntax");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SPEC_BYTES;
  // UTF-8 length is at most 3 bytes per UTF-16 unit; only measure exactly when it could matter.
  if (text.length * 3 > maxBytes && Buffer.byteLength(text, "utf8") > maxBytes) {
    return reject("too_large");
  }

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parsed = path.toLowerCase().endsWith(".json") ? parseJson(source) : parseYaml(source);
  if (!parsed.ok) return reject(parsed.reason);

  const cloned = cloneBounded(parsed.value);
  if (!cloned.ok) return reject(cloned.reason);
  const spec = cloned.value;
  if (!isPlain(spec)) return reject("not_a_spec");

  let format: ApiSpecFormat;
  let specVersion: string;
  const { openapi, swagger } = spec;
  if (openapi === undefined && swagger === undefined) return reject("not_a_spec");
  if (typeof openapi === "string" && openapi.startsWith("3.")) {
    format = "openapi";
    specVersion = openapi;
  } else if (openapi === undefined && (swagger === "2.0" || swagger === 2)) {
    // An unquoted `swagger: 2.0` is the number 2 in YAML; it is the same version.
    format = "swagger";
    specVersion = "2.0";
  } else {
    return reject("unsupported_version");
  }

  if (!isPlain(spec.info)) return reject("missing_info");
  const hasPaths = isPlain(spec.paths);
  const is31 = format === "openapi" && specVersion.startsWith("3.1");
  if (!hasPaths && !(is31 && (isPlain(spec.components) || isPlain(spec.webhooks)))) {
    return reject("missing_paths");
  }

  const operationCount = countOperations(spec);
  if (operationCount > MAX_API_SPEC_OPERATIONS) return reject("too_many_operations");

  return {
    ok: true,
    format,
    specVersion: clean(specVersion).slice(0, MAX_LABEL_LENGTH),
    title: label(spec.info.title) ?? clean(path),
    apiVersion: label(spec.info.version),
    operationCount,
    spec: spec as ApiSpecDocument,
  };
}
