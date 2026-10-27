import { describe, expect, it } from "vitest";

import { syncEventOf } from "./runs";

const result = (over: Record<string, unknown>) =>
  ({ githubId: 7, status: "ok", added: 2, updated: 1, removed: 0, ...over }) as never;

describe("syncEventOf", () => {
  it("reports a finished repository as sync.completed with document counts", () => {
    expect(syncEventOf(result({}), "webhook")).toEqual({
      name: "sync.completed",
      payload: { githubRepoId: 7, trigger: "webhook", added: 2, changed: 1, removed: 0 },
    });
  });

  it("reports a failed repository as sync.failed with its kind, never its message", () => {
    const event = syncEventOf(
      result({ status: "error", errorKind: "rate_limited", error: "secret detail" }),
      "schedule",
    );
    expect(event).toEqual({
      name: "sync.failed",
      payload: { githubRepoId: 7, trigger: "schedule", reason: "rate_limited" },
    });
    expect(JSON.stringify(event)).not.toContain("secret detail");
  });

  it("reports nothing for a skipped repository", () => {
    expect(syncEventOf(result({ status: "skipped" }), "manual")).toBeNull();
  });
});
