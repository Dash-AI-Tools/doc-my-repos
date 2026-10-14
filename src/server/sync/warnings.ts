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
}

const ORDER: readonly RepoSyncWarning["code"][] = [
  "docs_capped",
  "too_large",
  "size_unknown",
  "write_rejected",
  "unsupported",
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
  for (const skip of input.skipped) {
    const code = CODE_BY_REASON[skip.reason];
    if (code === undefined) continue;
    let set = groups.get(code);
    if (set === undefined) {
      set = new Set();
      groups.set(code, set);
    }
    set.add(skip.path);
  }
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
