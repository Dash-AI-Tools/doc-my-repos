import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusPageData } from "@docmyrepos/server/internal/status-page";

const loadStatusPage = vi.fn<() => Promise<StatusPageData>>();
vi.mock("@docmyrepos/server/internal/status-page", () => ({
  loadStatusPage: () => loadStatusPage(),
}));

import { StatusPage, metadata } from "./status";
import { testApp } from "./test-app";

const TEST_APP = testApp();

const NOW = new Date("2026-10-10T12:00:00Z");

const COUNTS = {
  repos: 3,
  ok: 2,
  failed: 1,
  skipped: 0,
  docsAdded: 4,
  docsUpdated: 1,
  docsRemoved: 2,
  docsSkipped: 3,
  warnings: 5,
};

function ok(over: Partial<Extract<StatusPageData, { status: "ok" }>["sync"]> = {}): StatusPageData {
  return {
    status: "ok",
    loadedAt: NOW,
    ask: { state: "off" },
    workspace: null,
    sync: {
      lastRun: {
        trigger: "schedule",
        scope: null,
        status: "partial",
        startedAt: new Date("2026-10-10T11:00:00Z"),
        finishedAt: new Date("2026-10-10T11:00:03Z"),
        durationMs: 3000,
        error: null,
        counts: COUNTS,
      },
      running: null,
      repos: [
        {
          owner: "acme",
          name: "api",
          visibility: "public",
          syncStatus: "ok",
          syncError: null,
          lastSyncedAt: new Date("2026-10-10T11:00:03Z"),
          warnings: [
            {
              code: "docs_capped",
              message: "Only the first 2 of 3 documentation files were synced.",
              count: 1,
            },
          ],
          skippedFiles: 1,
        },
        {
          owner: "acme",
          name: "flaky",
          visibility: "private",
          syncStatus: "error",
          syncError: "<b>GitHub rate limit exhausted</b>",
          lastSyncedAt: null,
          warnings: [],
          skippedFiles: 0,
        },
      ],
      reposTotal: 2,
      reposByStatus: { ok: 1, error: 1, pending: 0 },
      reposWithWarnings: 1,
      truncated: false,
      ...over,
    },
  };
}

async function html(): Promise<string> {
  return renderToStaticMarkup(await StatusPage({ app: TEST_APP }));
}

beforeEach(() => loadStatusPage.mockReset());

function withAsk(
  data: Extract<StatusPageData, { status: "ok" }>,
  ask: Extract<StatusPageData, { status: "ok" }>["ask"],
): StatusPageData {
  return { ...data, ask };
}

describe("/status page", () => {
  it("is not indexed", () => {
    expect(metadata.title).toBe("Sync status");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows the last run with its counts and each repository's state", async () => {
    loadStatusPage.mockResolvedValue(ok());
    const out = await html();
    expect(out).toContain("<h1");
    expect(out).toContain("Sync status");
    expect(out).toContain("Partly failed");
    expect(out).toContain("scheduled sync of all repositories");
    expect(out).toContain("3 (2 ok, 1 failed, 0 skipped)");
    expect(out).toContain("4 added, 1 updated, 2 removed, 3 skipped");
    expect(out).toContain("3 s");
    expect(out).toContain('href="/acme/api"');
    expect(out).toContain("Synced with warnings");
    expect(out).toContain("Not synced: Only the first 2 of 3 documentation files were synced.");
    expect(out).toContain("Sync failed");
    expect(out).toContain("Last sync failed: &lt;b&gt;GitHub rate limit exhausted&lt;/b&gt;");
    expect(out).not.toContain("<b>");
    expect(out).toContain("Private");
    expect(out).toContain(
      "2 repositories: 1 synced, 1 failed, 0 pending; 1 repository with files not synced.",
    );
    expect(out).not.toContain("status-truncated");
    expect(out).not.toContain("status-running");
  });

  it("shows a running sync, a missing run, an empty list and a truncated list", async () => {
    loadStatusPage.mockResolvedValue(
      ok({
        lastRun: null,
        running: {
          trigger: "webhook",
          scope: "acme/api",
          startedAt: new Date("2026-10-10T11:59:00Z"),
        },
        repos: [],
        reposTotal: 0,
      }),
    );
    let out = await html();
    expect(out).toContain("No sync run has finished yet.");
    expect(out).toContain("A webhook of acme/api is running");
    expect(out).toContain("No repository has been synced yet.");

    loadStatusPage.mockResolvedValue(ok({ reposTotal: 900, truncated: true }));
    out = await html();
    expect(out).toContain("Showing the first 2 of 900 repositories.");
  });

  it("shows a failed run's error", async () => {
    const data = ok();
    if (data.status !== "ok" || data.sync.lastRun === null) throw new Error("fixture");
    loadStatusPage.mockResolvedValue({
      ...data,
      sync: {
        ...data.sync,
        lastRun: {
          ...data.sync.lastRun,
          status: "failed",
          error: "GitHub App installation unavailable",
        },
      },
    });
    const out = await html();
    expect(out).toContain('data-testid="status-last-run-error"');
    expect(out).toContain("GitHub App installation unavailable");
  });

  it("shows the Ask line: off, ready, and unavailable naming settings only", async () => {
    const data = ok();
    if (data.status !== "ok") throw new Error("fixture");
    const lines: [Parameters<typeof withAsk>[1], string[], string[]][] = [
      [{ state: "off" }, ["Off"], ["AI_"]],
      [
        { state: "ready", provider: "anthropic", model: "claude-x" },
        ["Ready", "Anthropic", "claude-x"],
        ["AI_"],
      ],
      [
        { state: "unavailable", missing: ["Anthropic API key"] },
        ["Unavailable", "Enter Anthropic API key on the Ask admin page."],
        [],
      ],
      [
        {
          state: "unavailable",
          missing: [],
          problem: "OpenAI-compatible base URL must be an https URL",
        },
        ["Unavailable", "OpenAI-compatible base URL must be an https URL."],
        [],
      ],
    ];
    for (const [ask, present, absent] of lines) {
      loadStatusPage.mockResolvedValue(withAsk(data, ask));
      const out = await html();
      expect(out).toContain('data-testid="status-ask"');
      for (const text of present) expect(out).toContain(text);
      for (const text of absent) expect(out).not.toContain(text);
    }
  });

  it("shows the workspace line: configured, or what needs attention by name only", async () => {
    const data = ok();
    if (data.status !== "ok") throw new Error("fixture");
    const clean = {
      missingGithub: [],
      encryptionKey: null,
      unreadable: [],
      invalidStored: false,
      retired: [],
    };
    loadStatusPage.mockResolvedValue({ ...data, workspace: clean });
    let out = await html();
    expect(out).toContain('data-testid="status-workspace"');
    expect(out).toContain("Configured");
    expect(out).toContain("GitHub is configured.");

    loadStatusPage.mockResolvedValue({
      ...data,
      workspace: {
        ...clean,
        missingGithub: ["github.appId", "github_private_key"],
        retired: ["GITHUB_APP_ID"],
      },
    });
    out = await html();
    expect(out).toContain("Needs attention");
    expect(out).toContain("Enter the GitHub App ID, the GitHub App private key");
    expect(out).toContain("GITHUB_APP_ID is still present but no longer read");

    // The settings could not be read: the section is left out rather than guessed.
    loadStatusPage.mockResolvedValue({ ...data, workspace: null });
    expect(await html()).not.toContain('data-testid="status-workspace"');
  });

  it("renders the in-page error state", async () => {
    loadStatusPage.mockResolvedValue({ status: "error", loadedAt: NOW });
    const out = await html();
    expect(out).toContain('data-testid="status-load-error"');
    expect(out).toContain("Sync status could not be loaded");
    expect(out).toContain('href="/status"');
  });
});
