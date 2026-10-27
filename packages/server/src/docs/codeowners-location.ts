/**
 * CODEOWNERS locations in GitHub's precedence order: `.github/`, then the repository root, then
 * `docs/`. Matching is exact and case-sensitive, like GitHub's; only these three paths count, so
 * `src/.github/CODEOWNERS` and `codeowners` are not used.
 */
export const CODEOWNERS_CANDIDATES = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

/**
 * A tree entry. `type` follows the Git tree API (`blob`, `tree`, `commit`); when present, only
 * `blob` is considered a file. A plain string is a path already known to be a file.
 */
export type TreeEntryLike = string | { readonly path: string; readonly type?: string };

/**
 * Picks the CODEOWNERS file GitHub would use from a repo tree, or null when there is none.
 * Pure and total: odd input (null, non-iterables, non-string paths) yields null, never a throw.
 */
export function pickCodeownersPath(
  entries: Iterable<TreeEntryLike> | null | undefined,
): string | null {
  const files = new Set<string>();
  try {
    if (entries == null) return null;
    for (const entry of entries) {
      if (typeof entry === "string") {
        files.add(entry);
      } else if (entry != null && typeof entry === "object" && typeof entry.path === "string") {
        if (entry.type === undefined || entry.type === "blob") files.add(entry.path);
      }
    }
  } catch {
    return null;
  }
  for (const candidate of CODEOWNERS_CANDIDATES) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}
