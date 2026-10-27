import type { RepoSyncWarning } from "../db/schema";
import { toDbText } from "./document-record";

/**
 * Visible sync warnings (task 12.3): the files of a repository the last content sync left out,
 * grouped by why, as stored in `repos.sync_warnings` and shown in the repository header and on
 * `/status`. Pure.
 *
 * Which skips are warnings:
 * - `docs_capped`: the docs folder holds more files than `limits.maxDocsPerRepo`; only the first
 *   ones in path order are synced (`over_limit` skips from the tree selection).
 * - `too_large`: over `limits.maxFileBytes` (tree selection, or persist's own text check).
 * - `size_unknown`: the tree did not report a size, so the cap could not be checked.
 * - `write_rejected`: Postgres refused the document (for example a search vector over 1 MB).
 * - `unsupported`: symlinks, submodules, invalid paths or entries with a doc-like name.
 * Files under an ignored folder (`node_modules`) or a dot-folder are left out by convention and
 * are not warnings; the sync run still records them.
 *
 * Bounded: one entry per code (at most five), each with at most `MAX_WARNING_PATHS` paths of at
 * most `MAX_WARNING_PATH_CHARS` characters. Messages are fixed texts plus numbers.
 */

export const MAX_WARNING_PATHS = 20;
export const MAX_WARNING_PATH_CHARS = 500;

export interface WarningSkip {
  readonly path: string;
  /** A tree-selection `SkipReason` or a persist skip reason. */
  readonly reason: string;
}

export interface RepoWarningInput {
  /** Files the tree selection and persist skipped, in any order. */
  readonly skipped: readonly WarningSkip[];
  /** Set when the document cap cut the selection. */
  readonly capped?: { readonly found: number; readonly limit: number } | null;
  /** The per-file cap in bytes, for the message. */
  readonly maxFileBytes: number;
  /** OpenAPI/Swagger spec files left out, grouped apart from documents. Absent: none. */
  readonly apiSpecs?: {
    /**
     * Tree-selection reasons (`ApiSpecSkipReason`) plus `invalid` (could not be read as a spec),
     * `write_rejected` (the database refused it) and `missing` (a configured path is not in the
     * repository).
     */
    readonly skipped: readonly WarningSkip[];
    /** The spec size cap in bytes, for the message. */
    readonly maxSpecBytes: number;
    /** The per-repository spec limit, for the message. */
    readonly limit: number;
  };
}

const ORDER: readonly RepoSyncWarning["code"][] = [
  "docs_capped",
  "too_large",
  "size_unknown",
  "write_rejected",
  "unsupported",
  "api_spec_over_limit",
  "api_spec_too_large",
  "api_spec_invalid",
  "api_spec_missing",
  "api_spec_unsupported",
];

const CODE_BY_REASON: Readonly<Record<string, RepoSyncWarning["code"]>> = {
  over_limit: "docs_capped",
  too_large: "too_large",
  size_unknown: "size_unknown",
  write_rejected: "write_rejected",
  not_regular_file: "unsupported",
  invalid_path: "unsupported",
  invalid_entry: "unsupported",
};

const SPEC_CODE_BY_REASON: Readonly<Record<string, RepoSyncWarning["code"]>> = {
  over_limit: "api_spec_over_limit",
  too_large: "api_spec_too_large",
  invalid: "api_spec_invalid",
  write_rejected: "api_spec_invalid",
  missing: "api_spec_missing",
  size_unknown: "api_spec_unsupported",
  not_regular_file: "api_spec_unsupported",
  invalid_path: "api_spec_unsupported",
  invalid_entry: "api_spec_unsupported",
  hidden: "api_spec_unsupported",
  ignored_folder: "api_spec_unsupported",
};

/** `256 KB` for whole kilobytes, else `1000 bytes`. */
export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

function files(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

function message(code: RepoSyncWarning["code"], count: number, input: RepoWarningInput): string {
  switch (code) {
    case "docs_capped": {
      const capped = input.capped;
      return capped
        ? `Only the first ${capped.limit} of ${capped.found} documentation files were synced (limit ${capped.limit} per repository); ${files(count)} left out.`
        : `${files(count)} left out by the per-repository document limit.`;
    }
    case "too_large":
      return `${files(count)} larger than ${formatByteLimit(input.maxFileBytes)} ${count === 1 ? "was" : "were"} not synced.`;
    case "size_unknown":
      return `${files(count)} without a known size ${count === 1 ? "was" : "were"} not synced.`;
    case "write_rejected":
      return `${files(count)} could not be stored (rejected by the database) and ${count === 1 ? "was" : "were"} not synced.`;
    case "unsupported":
      return `${files(count)} with an unsupported type or name (symlink, submodule, invalid path) ${count === 1 ? "was" : "were"} not synced.`;
    case "api_spec_over_limit":
      return `Only the first ${input.apiSpecs?.limit ?? 10} API spec files per repository are shown; ${files(count)} left out.`;
    case "api_spec_too_large":
      return `${files(count)} larger than ${formatByteLimit(input.apiSpecs?.maxSpecBytes ?? 0)} ${count === 1 ? "was" : "were"} not shown as an API reference.`;
    case "api_spec_invalid":
      return `${files(count)} could not be read as an OpenAPI or Swagger description and ${count === 1 ? "was" : "were"} not shown as an API reference.`;
    case "api_spec_missing":
      return `${files(count)} listed under apiSpecs ${count === 1 ? "was" : "were"} not found in the repository.`;
    case "api_spec_unsupported":
      return `${files(count)} with an unsupported type or name (symlink, submodule, hidden or ignored folder, invalid path) ${count === 1 ? "was" : "were"} not shown as an API reference.`;
  }
}

function clipPath(path: string): string {
  const clean = toDbText(path);
  return clean.length > MAX_WARNING_PATH_CHARS
    ? `${clean.slice(0, MAX_WARNING_PATH_CHARS - 1)}…`
    : clean;
}

/** The warnings to store for one content sync; empty when nothing was left out. */
export function buildRepoSyncWarnings(input: RepoWarningInput): RepoSyncWarning[] {
  const groups = new Map<RepoSyncWarning["code"], Set<string>>();
  const add = (code: RepoSyncWarning["code"] | undefined, path: string) => {
    if (code === undefined) return;
    let set = groups.get(code);
    if (set === undefined) {
      set = new Set();
      groups.set(code, set);
    }
    set.add(path);
  };
  for (const skip of input.skipped) add(CODE_BY_REASON[skip.reason], skip.path);
  for (const skip of input.apiSpecs?.skipped ?? [])
    add(SPEC_CODE_BY_REASON[skip.reason], skip.path);
  const out: RepoSyncWarning[] = [];
  for (const code of ORDER) {
    const set = groups.get(code);
    if (set === undefined || set.size === 0) continue;
    const sorted = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push({
      code,
      message: message(code, sorted.length, input),
      count: sorted.length,
      paths: sorted.slice(0, MAX_WARNING_PATHS).map(clipPath),
    });
  }
  return out;
}

/** The run-level warning for a capped selection (`sync_runs.results`). */
export function cappedRunWarning(capped: { found: number; limit: number }): {
  path: null;
  message: string;
} {
  return {
    path: null,
    message: `document limit reached: ${capped.found} docs files found, only the first ${capped.limit} synced`,
  };
}
