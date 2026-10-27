/**
 * Read-side shape of a repository's visible sync warnings (task 12.3), as stored in
 * `repos.sync_warnings` by the sync (`packages/server/src/sync/warnings.ts`). Pure: no React, no database,
 * so the query layer parses with it and components can take its type.
 */

export interface SyncWarningView {
  /** `docs_capped`, `too_large`, `size_unknown`, `write_rejected` or `unsupported`. */
  readonly code: string;
  /** Fixed text written by the sync (numbers only, never file contents). */
  readonly message: string;
  /** Files concerned. */
  readonly count: number;
  /** At most the first 20 of them, repo-relative. */
  readonly paths: readonly string[];
}

/** Bounds applied on read, a second guard behind the sync's own. */
export const MAX_SYNC_WARNINGS = 10;
export const MAX_SYNC_WARNING_PATHS = 20;
const MAX_TEXT = 500;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** The stored JSONB as a clean list: malformed entries are dropped, never thrown on. */
export function parseSyncWarnings(value: unknown): SyncWarningView[] {
  if (!Array.isArray(value)) return [];
  const out: SyncWarningView[] = [];
  for (const item of value as unknown[]) {
    if (out.length >= MAX_SYNC_WARNINGS) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const { code, message, count, paths } = item as Record<string, unknown>;
    if (typeof code !== "string" || code === "" || code.length > 64) continue;
    if (typeof message !== "string" || message === "") continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
    const list = Array.isArray(paths)
      ? (paths as unknown[])
          .filter((p): p is string => typeof p === "string" && p !== "")
          .slice(0, MAX_SYNC_WARNING_PATHS)
          .map(clip)
      : [];
    out.push({ code, message: clip(message), count, paths: list });
  }
  return out;
}

/** Total files left out across all warnings. */
export function skippedFileCount(warnings: readonly SyncWarningView[]): number {
  return warnings.reduce((sum, w) => sum + w.count, 0);
}
