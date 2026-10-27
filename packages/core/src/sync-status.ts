/**
 * Labels for sync state in the repository header and on `/status` (task 12.2). Pure: no React, no
 * database. The values come from the query layer (`packages/server/src/queries/status.ts`).
 */

export type SyncTrigger = "webhook" | "manual" | "schedule" | "startup";
export type RepoRunOutcome = "ok" | "unchanged" | "error" | "skipped";
export type RunStatus = "success" | "partial" | "failed";
export type RepoSyncState = "pending" | "ok" | "error";

/** The tone of a status chip; each maps to a token pair checked for contrast. */
export type StatusTone = "success" | "warning" | "error";

const TRIGGER_LABELS: Record<SyncTrigger, string> = {
  webhook: "webhook",
  manual: "manual sync",
  schedule: "scheduled sync",
  startup: "startup sync",
};

export function triggerLabel(trigger: SyncTrigger): string {
  return TRIGGER_LABELS[trigger] ?? "sync";
}

const OUTCOME_LABELS: Record<RepoRunOutcome, string> = {
  ok: "updated",
  unchanged: "no changes",
  error: "failed",
  skipped: "skipped",
};

/** A repository's outcome in one run. */
export function runOutcomeLabel(outcome: RepoRunOutcome): string {
  return OUTCOME_LABELS[outcome] ?? "unknown";
}

const RUN_STATUS: Record<RunStatus, { label: string; tone: StatusTone }> = {
  success: { label: "Succeeded", tone: "success" },
  partial: { label: "Partly failed", tone: "warning" },
  failed: { label: "Failed", tone: "error" },
};

/** A whole run's status. */
export function runStatusChip(status: RunStatus): { label: string; tone: StatusTone } {
  return RUN_STATUS[status] ?? RUN_STATUS.failed;
}

/** A repository's current sync state, with warnings taken into account. */
export function repoStatusChip(
  status: RepoSyncState,
  warningCount: number,
): { label: string; tone: StatusTone } {
  if (status === "error") return { label: "Sync failed", tone: "error" };
  if (status === "pending") return { label: "Pending", tone: "warning" };
  if (warningCount > 0) return { label: "Synced with warnings", tone: "warning" };
  return { label: "Synced", tone: "success" };
}

/** Tailwind classes of a chip tone (token pairs only). */
export const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success text-success-foreground",
  warning: "bg-warning text-warning-foreground",
  error: "bg-destructive-muted text-destructive-muted-foreground",
};

/** `1 file`, `3 files`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `850 ms`, `12 s`, `3 min 5 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
