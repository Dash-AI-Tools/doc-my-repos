import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { osErrorCode, parseEnv, type EnvConfig, type EnvSource, type FileReader } from "./env";
import { configSchema, formatConfigIssues, type AppConfig } from "./schema";

export const DEFAULT_CONFIG_FILE = "docmyrepos.config.yml";
export const CONFIG_PATH_VAR = "CONFIG_PATH";

/** Aliases are pointless in a config this small; a low cap rules out alias-expansion bombs. */
const MAX_YAML_ALIASES = 10;

/** Far deeper than any valid config (the deepest field is `repos.0.docsPath`). */
const MAX_YAML_DEPTH = 32;

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export interface LoadedConfig {
  /** The config file as named by `CONFIG_PATH` or the default, and whether it existed. */
  readonly configFile: { readonly path: string; readonly found: boolean };
  /** Validated `docmyrepos.config.yml` with defaults applied. */
  readonly config: DeepReadonly<AppConfig>;
  /** Validated environment; secrets are wrapped in `Secret`. */
  readonly env: EnvConfig;
}

export interface LoadConfigOptions {
  /** Defaults to `process.env`. */
  env?: EnvSource;
  /** Defaults to a UTF-8 `fs.readFileSync`. */
  readFile?: FileReader;
  /** Base for a relative config path. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Thrown when the config file or the environment is invalid. `problems` lists one line per
 * missing or invalid item, naming the variable or the file and field. It never holds a secret.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
    super(`Invalid configuration (${count}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = Object.freeze([...problems]);
  }
}

const defaultReadFile: FileReader = (path) => readFileSync(path, "utf8");

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

type TreeFailure = "circular" | "too deep";

type TreeCheck =
  { failure: null; nullPaths: Set<string> } | { failure: TreeFailure; nullPaths: null };

/**
 * Walks the converted YAML once, before the schema or the error formatting sees it. Rejects a
 * value that contains itself (an alias to one of its own ancestors, such as `x: &a [*a]`) and
 * one nested deeper than `MAX_YAML_DEPTH`, so the recursion here is bounded by that limit.
 * Otherwise returns the dotted paths (as `formatConfigIssues` prints them) of every key or item
 * left without a value.
 */
function checkTree(root: unknown): TreeCheck {
  const nullPaths = new Set<string>();
  // Objects on the path from the root to the current value; shared, non-circular aliases are fine.
  const ancestors = new Set<object>();

  const walk = (value: unknown, path: readonly string[]): TreeFailure | null => {
    if (value === null) {
      if (path.length > 0) nullPaths.add(path.join("."));
      return null;
    }
    if (typeof value !== "object") return null;
    if (ancestors.has(value)) return "circular";
    if (path.length >= MAX_YAML_DEPTH) return "too deep";
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      const failure = walk(child, [...path, key]);
      if (failure !== null) return failure;
    }
    ancestors.delete(value);
    return null;
  };

  const failure = walk(root, []);
  return failure === null ? { failure, nullPaths } : { failure, nullPaths: null };
}

/**
 * The `yaml` package throws a plain `ReferenceError` with this fixed text, and no error code,
 * when `maxAliasCount` is exceeded.
 */
const ALIAS_LIMIT_MESSAGE = "Excessive alias count indicates a resource exhaustion attack";

function isAliasLimitError(error: unknown): boolean {
  return error instanceof ReferenceError && error.message === ALIAS_LIMIT_MESSAGE;
}

/** The `yaml` error code (such as `BAD_ALIAS`), formatted like syntax errors; never the message. */
function yamlErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) {
      return code.toLowerCase().replaceAll("_", " ");
    }
  }
  return "unknown error";
}

/** Iterative, so depth cannot overflow the stack; an already frozen object is not revisited. */
function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "object" && item !== null && !Object.isFrozen(item)) {
      Object.freeze(item);
      pending.push(...Object.values(item));
    }
  }
  return value;
}

function tooDeep(name: string): string {
  return `${name}: YAML is nested too deeply (limit ${MAX_YAML_DEPTH} levels)`;
}

type FileResult =
  | { config: AppConfig; found: boolean; problems: [] }
  | { config: null; found: boolean; problems: string[] };

function loadConfigFile(
  name: string,
  fullPath: string,
  explicit: boolean,
  readFile: FileReader,
): FileResult {
  let text: string;
  try {
    text = readFile(fullPath);
  } catch (error) {
    if (isMissingFile(error) && !explicit) {
      // No file: no narrowing, every repository the installation can access.
      return { config: configSchema.parse({}), found: false, problems: [] };
    }
    const problem = isMissingFile(error)
      ? `${CONFIG_PATH_VAR}: config file ${name} does not exist (ENOENT)`
      : `${name}: config file cannot be read (${osErrorCode(error)})`;
    return { config: null, found: false, problems: [problem] };
  }

  // YAML 1.2 core schema: no merge keys, no custom tags, duplicate keys are errors.
  // `logLevel: "error"` stops `yaml` from calling `process.emitWarning` with config text; its
  // warnings are still collected in `doc.warnings` and reported below without that text.
  // Not "silent": that level also drops the MULTIPLE_DOCS error.
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    logLevel: "error",
  });
  const yamlIssues = [...doc.errors, ...doc.warnings];
  // `yaml` reports a stack overflow while composing deep nesting as RESOURCE_EXHAUSTION. Where
  // it happens depends on the stack size, so it gets one fixed message without a position.
  if (yamlIssues.some((e) => e.code === "RESOURCE_EXHAUSTION")) {
    return { config: null, found: true, problems: [tooDeep(name)] };
  }
  if (yamlIssues.length > 0) {
    // Only the error code and position are reported, never the offending source text.
    const problems = yamlIssues.map((e) => {
      const at = e.linePos?.[0];
      const where = at ? ` at line ${at.line}, column ${at.col}` : "";
      return `${name}: YAML syntax error${where} (${e.code.toLowerCase().replaceAll("_", " ")})`;
    });
    return { config: null, found: true, problems };
  }

  let raw: unknown;
  try {
    // An empty or comment-only file has no contents and means the default config.
    raw = doc.contents === null ? {} : doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch (error) {
    // The error message can quote the document (an alias name, for instance); never report it.
    const problem = isAliasLimitError(error)
      ? `${name}: YAML uses too many aliases (limit ${MAX_YAML_ALIASES})`
      : `${name}: YAML could not be converted: ${yamlErrorCode(error)}`;
    return { config: null, found: true, problems: [problem] };
  }

  const tree = checkTree(raw);
  if (tree.failure !== null) {
    const problem =
      tree.failure === "circular" ? `${name}: YAML contains a circular reference` : tooDeep(name);
    return { config: null, found: true, problems: [problem] };
  }

  const parsed = configSchema.safeParse(raw, { reportInput: false });
  if (parsed.success) return { config: parsed.data, found: true, problems: [] };

  const problems = formatConfigIssues(parsed.error).map((line) => {
    const field = line.slice(0, line.indexOf(": "));
    const message = tree.nullPaths.has(field)
      ? `${field}: has no value; give a value or remove the key`
      : line;
    return `${name}: ${message}`;
  });
  return { config: null, found: true, problems };
}

/**
 * Loads `docmyrepos.config.yml` (or the file named by `CONFIG_PATH`) and validates it together
 * with the required environment variables. Collects every problem and throws one `ConfigError`.
 * Logs nothing.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultReadFile;
  const cwd = options.cwd ?? process.cwd();

  const configured = env[CONFIG_PATH_VAR]?.trim() ?? "";
  const explicit = configured !== "";
  const name = explicit ? configured : DEFAULT_CONFIG_FILE;

  const file = loadConfigFile(name, resolve(cwd, name), explicit, readFile);
  const parsedEnv = parseEnv(env, readFile);
  const problems = [...file.problems, ...parsedEnv.problems];

  if (file.config === null || parsedEnv.env === null || problems.length > 0) {
    throw new ConfigError(problems);
  }
  return Object.freeze({
    configFile: Object.freeze({ path: name, found: file.found }),
    config: deepFreeze(file.config),
    env: parsedEnv.env,
  });
}
