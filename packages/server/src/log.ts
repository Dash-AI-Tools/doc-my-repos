import { Secret } from "./config/secret";

/**
 * Structured logging for the server (task 12.4). Dependency-free and React-free; the one module in
 * `src/` allowed to write to the console streams (an ESLint `no-console` rule enforces that).
 *
 * Format: one JSON object per line, `{"ts":"<ISO 8601>","level":"info","service":"docmyrepos",
 * "event":"sync.run.finished",...fields}`. `debug` and `info` go to stdout, `warn` and `error` to
 * stderr. The threshold comes from `LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`; read on
 * every call, case-insensitive). An unset or unknown value means `info` here; the config loader
 * rejects an unknown value at startup with a `ConfigError` naming `LOG_LEVEL`.
 *
 * Safe by construction, because a log line is the easiest place for a credential to leak:
 * - Event names must look like `area.subject.verb` (lower case, digits, `_`, dots); anything else
 *   is logged as `invalid_event`.
 * - Every field passes through `sanitizeValue`: a key that names a credential (`token`, `secret`,
 *   `password`, `authorization`, `cookie`, `private key`, `jwt`, `signature`, `api key`,
 *   `credential`, `session`) has its value replaced by `[redacted]`, at any depth; strings are
 *   scrubbed of PEM blocks, `Bearer` credentials, GitHub token shapes (`ghp_`, `gho_`, `ghu_`,
 *   `ghs_`, `ghr_`, `github_pat_`), JWTs, `user:password@` in URLs and long mixed-case random runs;
 *   control characters (newlines, NUL, U+2028/U+2029, bidi overrides) become spaces; strings are cut
 *   at `MAX_STRING_LENGTH`, nesting at `MAX_DEPTH`, lists at `MAX_ITEMS`, objects at `MAX_KEYS`;
 *   cycles print `[circular]`.
 * - Errors are never serialized: an `Error` value becomes `errorFields(error)` (name, kind, code,
 *   status), never its message, stack or cause. A `Secret` prints `[redacted]`, as does a plain
 *   object with its own `toJSON` (the redacted database and runtime handles). Any other non-plain
 *   object (Request, Response, Buffer, Map, a pool, a class instance) prints `[Object <Class>]`.
 * - Logging never throws: a failing serializer or stream is swallowed.
 *
 * Git SHAs (40 or 64 lower-case hex characters) stay readable: the random-run rule only scrubs runs
 * that mix upper case, lower case and digits. The rules are a safety net; call sites still pass
 * only ids, counts, kinds and fixed words.
 */

export const LOG_LEVEL_VAR = "LOG_LEVEL";
export const LOG_THRESHOLDS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogThreshold = (typeof LOG_THRESHOLDS)[number];
export type LogLevel = Exclude<LogThreshold, "silent">;
export const DEFAULT_LOG_LEVEL: LogThreshold = "info";
export const SERVICE_NAME = "docmyrepos";

export type LogFields = Readonly<Record<string, unknown>>;
/** One log method: a stable event name and safe fields. */
export type LogFn = (event: string, fields?: LogFields) => void;

export interface Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  /** A logger that adds `bindings` (for example `{ runId }`) to every line. */
  child(bindings: LogFields): Logger;
}

export const REDACTED = "[redacted]";
export const MAX_STRING_LENGTH = 500;
/** Longer input is cut before the pattern scrub runs, so huge values cost bounded time. */
const MAX_SCAN_LENGTH = 8192;
export const MAX_DEPTH = 4;
export const MAX_ITEMS = 20;
export const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 64;

const RANK: Readonly<Record<LogThreshold, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** A `LOG_LEVEL` value, or null when it is not one of `LOG_THRESHOLDS` (case-insensitive). */
export function parseLogLevel(value: unknown): LogThreshold | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (LOG_THRESHOLDS as readonly string[]).includes(v) ? (v as LogThreshold) : null;
}

/** The threshold from `env`: unset, blank or unknown means `info`. */
export function logLevelFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LogThreshold {
  return parseLogLevel(env[LOG_LEVEL_VAR]) ?? DEFAULT_LOG_LEVEL;
}

// ---------------------------------------------------------------------------------------------
// Redaction

/** Keys whose values are never logged, whatever they hold. */
export const SENSITIVE_KEY =
  /token|secret|passw(or)?d|passwd|authori[sz]ation|cookie|private.?key|jwt|signature|api.?key|credential|session/i;

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

// Built from code points so this file holds no invisible characters: C0 controls, DEL, C1
// controls, the line and paragraph separators, and the bidi embedding/override/isolate controls.
const CONTROL = new RegExp(
  `[${[
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x2028, 0x2029],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]
    .map(([a, b]) => `\\u{${(a as number).toString(16)}}-\\u{${(b as number).toString(16)}}`)
    .join("")}\\u{feff}]`,
  "gu",
);

const PEM_BLOCK = /-----BEGIN[^-\n]{0,64}-----[\s\S]*?(?:-----END[^-\n]{0,64}-----|$)/g;
const PEM_MARKER = /-----(?:BEGIN|END)[^-\n]{0,64}-----/g;
const BEARER = /\b(bearer|basic)\s+[^\s,;"'<>]+/gi;
/** `Authorization: token <credential>` (GitHub's legacy scheme): only a credential-like word. */
const TOKEN_SCHEME = /\b(token)\s+(?=[A-Za-z0-9_.~+/=-]{20,})[^\s,;"'<>]+/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]*@/gi;
/** `access_token=...`, `client_secret=...`, `sig=...` in query strings and `key=value` text. */
const KEY_VALUE_SECRET =
  /([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|signature|jwt))=[^\s&;,"']+/gi;
/** A long run of base64/base64url characters; scrubbed only when it mixes case and digits. */
const RANDOM_RUN = /[A-Za-z0-9+_=-]{32,}/g;

function looksRandom(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/**
 * A string made safe for a log line: credential shapes replaced by `[redacted]`, control
 * characters replaced by spaces, at most `max` characters (then `…[truncated]`).
 */
export function scrubString(input: string, max: number = MAX_STRING_LENGTH): string {
  let s = input.length > MAX_SCAN_LENGTH ? input.slice(0, MAX_SCAN_LENGTH) : input;
  const cut = input.length > MAX_SCAN_LENGTH;
  s = s
    .replace(PEM_BLOCK, REDACTED)
    .replace(PEM_MARKER, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(TOKEN_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(JWT, REDACTED)
    .replace(KEY_VALUE_SECRET, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(RANDOM_RUN, (run) => (looksRandom(run) ? REDACTED : run))
    .replace(CONTROL, " ");
  if (s.length > max) return `${s.slice(0, max)}…[truncated]`;
  return cut ? `${s}…[truncated]` : s;
}

function safeKey(key: string): string {
  const clean = scrubString(key, MAX_KEY_LENGTH);
  return clean === "" ? "_" : clean;
}

function className(value: object): string {
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    const ctor =
      proto !== null && typeof proto === "object"
        ? (proto as { constructor?: unknown }).constructor
        : undefined;
    const name = typeof ctor === "function" ? ctor.name : "";
    return CLASS_NAME.test(name) ? name : "Object";
  } catch {
    return "Object";
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------------------------
// Errors

/** What a log line may say about an error. Never its message, stack or cause. */
export type ErrorFields = {
  errorName: string;
  /** A safe kind word: `GitHubError.kind`, `PersistError.kind`, `RepoSyncError.kind`, ... */
  errorKind?: string;
  /** A SQLSTATE (`23505`), an OS code (`ECONNREFUSED`) or a similar upper-case code. */
  code?: string;
  /** An HTTP status (GitHub errors). */
  status?: number;
  /** For rate limits: how long GitHub asked to wait. */
  retryAfterMs?: number;
};

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const KIND_WORD = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^[A-Z0-9_]{2,32}$/;

function read(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The loggable facts about a thrown value. Uses only the safe vocabularies the code already has:
 * the error's `name`, a `kind` word (GitHub, persist, sync and lock errors), an HTTP `status`, a
 * `retryAfterMs`, and the first upper-case `code` along the `cause` chain (SQLSTATE or OS code, as
 * `describeDbError` reads it). Never throws.
 */
export function errorFields(error: unknown): ErrorFields {
  try {
    if (typeof error !== "object" || error === null) {
      return { errorName: `non_error_${typeof error}` };
    }
    const name = read(error, "name");
    const out: ErrorFields = {
      errorName: typeof name === "string" && ERROR_NAME.test(name) ? name : className(error),
    };
    const kind = read(error, "kind");
    if (typeof kind === "string" && KIND_WORD.test(kind)) out.errorKind = kind;
    if (error instanceof Error && error.name === "ConfigError") out.errorKind ??= "config";
    const status = read(error, "status");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600) {
      out.status = status;
    }
    const retry = read(error, "retryAfterMs");
    if (typeof retry === "number" && Number.isFinite(retry) && retry >= 0) {
      out.retryAfterMs = Math.round(retry);
    }
    for (let e: unknown = error, depth = 0; typeof e === "object" && e !== null && depth < 4;) {
      const code = read(e, "code");
      if (typeof code === "string" && ERROR_CODE.test(code)) {
        out.code = code;
        break;
      }
      e = read(e, "cause");
      depth++;
    }
    return out;
  } catch {
    return { errorName: "unknown" };
  }
}

// ---------------------------------------------------------------------------------------------
// Values

/**
 * A JSON-safe copy of `value` with every rule of the module comment applied. `key` is the property
 * name the value sits under (credential keys are redacted whatever the value). Never throws.
 */
export function sanitizeValue(value: unknown, key?: string): unknown {
  return walk(value, key, 0, new Set());
}

function walk(value: unknown, key: string | undefined, depth: number, seen: Set<object>): unknown {
  try {
    if (key !== undefined && SENSITIVE_KEY.test(key)) {
      return value === undefined || value === null ? value : REDACTED;
    }
    switch (typeof value) {
      case "string":
        return scrubString(value);
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "boolean":
      case "undefined":
        return value;
      case "bigint":
        return value.toString();
      case "symbol":
        return "[symbol]";
      case "function":
        return "[function]";
    }
    if (value === null) return null;
    const obj = value as object;
    if (obj instanceof Secret) return REDACTED;
    if (obj instanceof Error) return errorFields(obj);
    if (obj instanceof Date) {
      return Number.isNaN(obj.getTime()) ? "[invalid date]" : obj.toISOString();
    }
    if (seen.has(obj)) return "[circular]";
    if (Array.isArray(obj)) {
      if (depth >= MAX_DEPTH) return "[array]";
      seen.add(obj);
      const items = obj
        .slice(0, MAX_ITEMS)
        .map((item) => walk(item, undefined, depth + 1, seen) ?? null);
      if (obj.length > MAX_ITEMS) items.push(`[+${obj.length - MAX_ITEMS} more]`);
      seen.delete(obj);
      return items;
    }
    if (!isPlainObject(obj)) return `[Object ${className(obj)}]`;
    // The redacted handles (`redactWhenLogged`) are plain objects with their own `toJSON`.
    if (Object.prototype.hasOwnProperty.call(obj, "toJSON")) return REDACTED;
    if (depth >= MAX_DEPTH) return "[object]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const k of keys.slice(0, MAX_KEYS)) {
      let child: unknown;
      try {
        child = (obj as Record<string, unknown>)[k];
      } catch {
        out[safeKey(k)] = "[unserializable]";
        continue;
      }
      out[safeKey(k)] = walk(child, k, depth + 1, seen);
    }
    if (keys.length > MAX_KEYS) out["_truncatedKeys"] = keys.length - MAX_KEYS;
    seen.delete(obj);
    return out;
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------------------------
// Logger

/** Receives one finished line (with its trailing newline) and its level. */
export type LogWriter = (line: string, level: LogLevel) => void;

export interface LoggerOptions {
  /** Default `SERVICE_NAME`. */
  service?: string;
  /** Fixed threshold. Default: `LOG_LEVEL` from `process.env`, read on every call. */
  level?: LogThreshold | (() => LogThreshold);
  /** Default: stdout for `debug`/`info`, stderr for `warn`/`error`. */
  write?: LogWriter;
  now?: () => Date;
  /** Fields added to every line. */
  bindings?: LogFields;
}

const RESERVED = new Set(["ts", "level", "service", "event"]);

const defaultWrite: LogWriter = (line, level) => {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(line);
};

function addFields(target: Record<string, unknown>, fields: LogFields | undefined): void {
  if (fields === undefined || fields === null || typeof fields !== "object") return;
  const keys = Object.keys(fields);
  for (const k of keys.slice(0, MAX_KEYS)) {
    const name = safeKey(k);
    const value = walk((fields as Record<string, unknown>)[k], k, 1, new Set());
    if (value === undefined) continue;
    target[RESERVED.has(name) ? `field_${name}` : name] = value;
  }
}

/**
 * Formats one log line. Exported for tests; `createLogger` is the normal entry point. Never throws.
 */
export function formatLine(
  level: LogLevel,
  event: string,
  fields: LogFields | undefined,
  context: { service: string; now: Date; bindings: readonly LogFields[] },
): string {
  const record: Record<string, unknown> = {
    ts: Number.isNaN(context.now.getTime()) ? null : context.now.toISOString(),
    level,
    service: scrubString(context.service, 64),
    event:
      typeof event === "string" && event.length <= 64 && EVENT_NAME.test(event)
        ? event
        : "invalid_event",
  };
  for (const bound of context.bindings) addFields(record, bound);
  addFields(record, fields);
  return `${JSON.stringify(record)}\n`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const service = options.service ?? SERVICE_NAME;
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const threshold = (): LogThreshold => {
    const level = options.level;
    if (typeof level === "function") return parseLogLevel(level()) ?? DEFAULT_LOG_LEVEL;
    return parseLogLevel(level) ?? logLevelFromEnv();
  };

  const build = (bindings: readonly LogFields[]): Logger => {
    const emit =
      (level: LogLevel): LogFn =>
      (event, fields) => {
        try {
          if (RANK[level] < RANK[threshold()]) return;
          write(formatLine(level, event, fields, { service, now: now(), bindings }), level);
        } catch {
          // Logging must never break the caller.
        }
      };
    return Object.freeze({
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (extra: LogFields) => build([...bindings, extra]),
    });
  };
  return build(options.bindings === undefined ? [] : [options.bindings]);
}

/** The process logger. */
export const logger: Logger = createLogger();
