import { describe, expect, it } from "vitest";

import {
  formatDuration,
  plural,
  repoStatusChip,
  runOutcomeLabel,
  runStatusChip,
  TONE_CLASSES,
  triggerLabel,
} from "./sync-status";

describe("sync status labels", () => {
  it("labels triggers, outcomes and run statuses", () => {
    expect(triggerLabel("webhook")).toBe("webhook");
    expect(triggerLabel("schedule")).toBe("scheduled sync");
    expect(runOutcomeLabel("unchanged")).toBe("no changes");
    expect(runOutcomeLabel("error")).toBe("failed");
    expect(runStatusChip("partial")).toEqual({ label: "Partly failed", tone: "warning" });
    expect(runStatusChip("failed").tone).toBe("error");
  });

  it("picks the repository chip from status and warnings", () => {
    expect(repoStatusChip("ok", 0)).toEqual({ label: "Synced", tone: "success" });
    expect(repoStatusChip("ok", 2)).toEqual({ label: "Synced with warnings", tone: "warning" });
    expect(repoStatusChip("error", 2)).toEqual({ label: "Sync failed", tone: "error" });
    expect(repoStatusChip("pending", 0)).toEqual({ label: "Pending", tone: "warning" });
  });

  it("maps tones to token pairs only", () => {
    expect(TONE_CLASSES.success).toBe("bg-success text-success-foreground");
    expect(TONE_CLASSES.warning).toBe("bg-warning text-warning-foreground");
    expect(TONE_CLASSES.error).toBe("bg-destructive-muted text-destructive-muted-foreground");
  });

  it("formats durations and plurals", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
  });
});
