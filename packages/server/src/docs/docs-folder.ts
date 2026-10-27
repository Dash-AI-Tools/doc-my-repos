import { DEFAULT_DOCS_PATHS } from "@docmyrepos/core/internal/config/schema";
import type { TreeEntryLike } from "./codeowners-location";

export interface DocsFolderOptions {
  /** Per-repo override (`docsPath`). When set it is authoritative: no fallback to the defaults. */
  readonly docsPath?: string | null;
  /** Candidate list (`defaults.docsPaths`). Falls back to `DEFAULT_DOCS_PATHS` when absent. */
  readonly defaults?: readonly string[] | null;
}

/**
 * Normalizes a configured folder path to `a/b` form, or returns null when it is unusable.
 * Strips surrounding whitespace, `./` segments, repeated and trailing slashes. Rejects absolute
 * paths, backslashes, `..` segments, NUL and other control characters, and empty results, so a
 * value can never point outside the repository root.
 */
export function normalizeDocsPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (
    raw === "" ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/** Every directory path implied by the tree: `a/b/c.md` gives `a` and `a/b`; `tree` entries count too. */
function collectDirectories(entries: Iterable<TreeEntryLike>): Set<string> {
  const dirs = new Set<string>();
  const addPrefixes = (path: string, includeSelf: boolean) => {
    const parts = path.split("/").filter((p) => p !== "");
    const last = includeSelf ? parts.length : parts.length - 1;
    for (let i = 1; i <= last; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const entry of entries) {
    if (typeof entry === "string") {
      addPrefixes(entry, false);
    } else if (entry != null && typeof entry === "object" && typeof entry.path === "string") {
      if (entry.type === "tree") addPrefixes(entry.path, true);
      else if (entry.type === undefined || entry.type === "blob") addPrefixes(entry.path, false);
      // `commit` (submodule) entries are neither files nor directories we can read.
    }
  }
  return dirs;
}

/** Among directories equal ignoring case: exact-case match first, then lexicographic order. */
function resolve(candidate: string, byLower: Map<string, string[]>): string | null {
  const matches = byLower.get(candidate.toLowerCase());
  if (!matches || matches.length === 0) return null;
  if (matches.includes(candidate)) return candidate;
  return [...matches].sort()[0] ?? null;
}

/**
 * Picks the docs folder for a repo tree, keeping the case found in the tree, or null when there
 * is none (the empty-docs state). Pure and total: odd input yields null, never a throw.
 *
 * - A configured `docsPath` is authoritative: if it is invalid or missing from the tree the result
 *   is null, with no fallback to the defaults.
 * - Otherwise the first default that exists wins (`docs`, then `doc`, then `documentation`).
 * - Matching is case-insensitive. If the tree has several directories differing only in case, the
 *   candidate's exact spelling wins, else the lexicographically first one.
 * - Only directories count; a file named `docs` does not. Nested paths (`packages/x/docs`) are
 *   allowed because the config schema allows them.
 */
export function findDocsFolder(
  entries: Iterable<TreeEntryLike> | null | undefined,
  options: DocsFolderOptions = {},
): string | null {
  try {
    if (entries == null) return null;
    const byLower = new Map<string, string[]>();
    for (const dir of collectDirectories(entries)) {
      const key = dir.toLowerCase();
      const list = byLower.get(key);
      if (list) list.push(dir);
      else byLower.set(key, [dir]);
    }

    const override = options?.docsPath;
    if (override != null) {
      const normalized = normalizeDocsPath(override);
      return normalized === null ? null : resolve(normalized, byLower);
    }

    const defaults = Array.isArray(options?.defaults) ? options.defaults : DEFAULT_DOCS_PATHS;
    for (const candidate of defaults) {
      const normalized = normalizeDocsPath(candidate);
      if (normalized === null) continue;
      const found = resolve(normalized, byLower);
      if (found !== null) return found;
    }
    return null;
  } catch {
    return null;
  }
}
