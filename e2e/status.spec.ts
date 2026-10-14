import type { Page } from "@playwright/test";

import { expect, test } from "./support/csp";
import { CAPPED_LEFT_OUT, SEED_REPOS, SEEDED, SEEDED_PRIVATE } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Tasks 12.2 and 12.3 in a real browser against the seeded database: sync state in the repository
 * header (status chip, last run, failure, files not synced), the `/status` page and the
 * `GET /api/status` JSON. The seeded runs (`SEED_RUNS`) are a successful full run and, later, a
 * partial manual run in which acme/flaky-service failed. acme/capped-docs was synced over the
 * document and size caps. Accessibility of these states (both themes) is in accessibility.spec.ts.
 */

const KEY = "docmyrepos-theme";
const repoName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
const path = (r: { owner: string; name: string }) => `/${r.owner}/${r.name}`;

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [KEY, theme],
  );
}

const STORED = SEED_REPOS.filter((r) => r.state !== "pending").length;

test.describe("sync status in the repository header", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test("an errored repository shows the failure, its last run and the stored content's time", async ({
    page,
  }) => {
    await page.goto(path(SEEDED.errored));
    const header = page.getByTestId("repo-header");
    await expect(header.getByTestId("repo-sync-status")).toHaveText("Sync failed");
    await expect(header.getByTestId("repo-sync-status")).toHaveAttribute("data-tone", "error");
    const box = header.getByTestId("repo-sync-error");
    await expect(box).toContainText("Last sync failed");
    await expect(box).toContainText("GitHub rate limit exhausted; retry later");
    await expect(box).toContainText("Showing previously synced content.");
    await expect(box.getByTestId("repo-sync-error-stored")).toContainText("Last successful sync:");
    await expect(box.getByTestId("repo-sync-error-stored").locator("time")).toHaveAttribute(
      "datetime",
      "2026-02-01T08:15:00.000Z",
    );
    const run = header.getByTestId("repo-last-run");
    await expect(run).toContainText("Last run: manual sync");
    await expect(run).toContainText("failed");
    await expect(run.locator("time")).toHaveAttribute("datetime", "2026-03-15T08:00:05.000Z");
    // stored content stays on the page
    await expect(page.getByTestId("readme-body")).toContainText("Stored content");
  });

  test("a synced repository shows the synced chip, last synced and an unchanged last run", async ({
    page,
  }) => {
    await page.goto(path(SEEDED.full));
    const header = page.getByTestId("repo-header");
    await expect(header.getByTestId("repo-sync-status")).toHaveText("Synced");
    await expect(header.getByTestId("repo-meta")).toContainText("Last synced");
    await expect(header.getByTestId("repo-last-run")).toContainText("no changes");
    await expect(header.getByTestId("repo-sync-error")).toHaveCount(0);
    await expect(header.getByTestId("repo-sync-warnings")).toHaveCount(0);
  });

  test("a pending repository shows the pending chip and no last run", async ({ page }) => {
    await page.goto(path(SEEDED.pending));
    const header = page.getByTestId("repo-header");
    await expect(header.getByTestId("repo-sync-status")).toHaveText("Pending");
    await expect(header.getByTestId("repo-last-run")).toHaveCount(0);
    await expect(header.getByTestId("repo-pending")).toBeVisible();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`a capped repository warns which files were not synced (${theme})`, async ({ page }) => {
      await setTheme(page, theme);
      await page.goto(path(SEEDED.capped));
      const header = page.getByTestId("repo-header");
      await expect(header.getByTestId("repo-sync-status")).toHaveText("Synced with warnings");
      const box = header.getByTestId("repo-sync-warnings");
      await expect(box).toBeVisible();
      await expect(box).toHaveAttribute("role", "status");
      await expect(box).toContainText("Some files were not synced");
      await expect(box).toContainText("24 files in this repository are not shown.");
      const first = box.getByText(CAPPED_LEFT_OUT[0] as string);
      await expect(first).toBeHidden();
      await box.getByText("Show details").click();
      await expect(first).toBeVisible();
      const items = box.getByTestId("sync-warning");
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText(
        "Only the first 2 of 25 documentation files were synced (limit 2 per repository); 23 files left out.",
      );
      await expect(items.nth(0)).toContainText("and 3 more files");
      await expect(items.nth(1)).toContainText("1 file larger than 256 KB was not synced.");
      await expect(items.nth(1)).toContainText("docs/huge-export.md");
      // only the kept documents are browsable
      await expect(page.getByTestId("docs-nav")).toContainText("2 documents");
      await expect(header.getByTestId("repo-last-run")).toContainText("no changes");
      await page.screenshot({
        path: test.info().outputPath(`capped-${theme}.png`),
        fullPage: true,
      });
    });
  }
});

test.describe("/status page", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test("is linked from the footer and lists the last run and every repository", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("footer-status-link").click();
    await expect(page).toHaveURL(`${stackUrl("seeded")}/status`);
    await expect(page).toHaveTitle("Sync status · DocMyRepos");
    await expect(page.getByRole("heading", { level: 1, name: "Sync status" })).toBeVisible();

    const run = page.getByTestId("status-last-run");
    await expect(run.getByTestId("status-last-run-status")).toHaveText("Partly failed");
    await expect(run).toContainText("manual sync of all repositories");
    await expect(run).toContainText(`${STORED} (${STORED - 1} ok, 1 failed, 0 skipped)`);
    await expect(run).toContainText("5 s");
    await expect(page.getByTestId("status-running")).toHaveCount(0);

    const rows = page.getByTestId("status-repo");
    await expect(rows).toHaveCount(SEED_REPOS.length);
    await expect(page.getByTestId("status-summary")).toContainText(
      `${SEED_REPOS.length} repositories: ${STORED - 1} synced, 1 failed, 1 pending; 1 repository with files not synced.`,
    );
  });

  test("shows the errored repository with its error, the capped one with its warnings, and private ones", async ({
    page,
  }) => {
    await page.goto("/status");
    const row = (r: { owner: string; name: string }) =>
      page.locator(`[data-testid="status-repo"][data-repo="${repoName(r)}"]`);

    const flaky = row(SEEDED.errored);
    await expect(flaky.getByTestId("status-repo-status")).toHaveText("Sync failed");
    await expect(flaky.getByTestId("status-repo-error")).toHaveText(
      "Last sync failed: GitHub rate limit exhausted; retry later",
    );
    await expect(flaky.getByRole("link", { name: repoName(SEEDED.errored) })).toHaveAttribute(
      "href",
      path(SEEDED.errored),
    );

    const capped = row(SEEDED.capped);
    await expect(capped.getByTestId("status-repo-status")).toHaveText("Synced with warnings");
    await expect(capped.getByTestId("status-repo-warnings")).toContainText(
      "Only the first 2 of 25 documentation files were synced",
    );
    await expect(capped.getByTestId("status-repo-warnings")).toContainText(
      "1 file larger than 256 KB",
    );

    await expect(row(SEEDED.pending).getByTestId("status-repo-status")).toHaveText("Pending");
    await expect(row(SEEDED.full).getByTestId("status-repo-status")).toHaveText("Synced");
    // MVP visibility filter: private repositories are listed too
    for (const name of SEEDED_PRIVATE) {
      await expect(page.locator(`[data-testid="status-repo"][data-repo="${name}"]`)).toContainText(
        "Private",
      );
    }
  });
});

test.describe("/status without data or database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);

  test("an empty database says nothing has run", async ({ page }) => {
    await page.goto(`${stackUrl("empty")}/status`);
    await expect(page.getByTestId("status-no-run")).toBeVisible();
    await expect(page.getByTestId("status-no-repos")).toBeVisible();
  });
});

test.describe("GET /api/status", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);

  test("answers JSON with the last run, the errored and capped repositories, and no internals", async ({
    request,
  }) => {
    const res = await request.get(`${stackUrl("seeded")}/api/status`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["content-type"]).toBe("application/json; charset=utf-8");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(
      ["generatedAt", "lastRun", "repos", "running", "summary", "truncated"].sort(),
    );
    expect(body.running).toBeNull();
    expect(body.truncated).toBe(false);
    expect(body.lastRun).toMatchObject({
      trigger: "manual",
      scope: null,
      status: "partial",
      startedAt: "2026-03-15T08:00:00.000Z",
      finishedAt: "2026-03-15T08:00:05.000Z",
      durationMs: 5000,
      error: null,
      counts: { repos: STORED, ok: STORED - 1, failed: 1, skipped: 0 },
    });
    expect(body.summary).toEqual({
      repos: SEED_REPOS.length,
      ok: STORED - 1,
      error: 1,
      pending: 1,
      withWarnings: 1,
    });
    expect(body.repos).toHaveLength(SEED_REPOS.length);
    const byName = new Map<string, Record<string, unknown>>(
      body.repos.map((r: { owner: string; name: string }) => [repoName(r), r]),
    );
    expect(byName.get(repoName(SEEDED.errored))).toEqual({
      owner: "acme",
      name: "flaky-service",
      visibility: "public",
      syncStatus: "error",
      syncError: "GitHub rate limit exhausted; retry later",
      lastSyncedAt: "2026-02-01T08:15:00.000Z",
      warnings: [],
      skippedFiles: 0,
    });
    expect(byName.get(repoName(SEEDED.capped))).toMatchObject({
      syncStatus: "ok",
      skippedFiles: 24,
      warnings: [
        { code: "docs_capped", count: 23 },
        { code: "too_large", count: 1 },
      ],
    });
    for (const name of SEEDED_PRIVATE) {
      expect(byName.get(name)).toMatchObject({ visibility: "private" });
    }
    // no internal fields or values (GitHub ids, SHAs, ETags, paths of skipped files)
    expect(text).not.toMatch(/githubId|treeSha|tree_sha|etag|fingerprint|requested|e2e-10/i);
    expect(text).not.toMatch(/\b[0-9a-f]{40}\b/);
    expect(text).not.toContain("zz-extra");
  });

  test("refuses other methods", async ({ request }) => {
    const res = await request.post(`${stackUrl("seeded")}/api/status`);
    expect(res.status()).toBe(405);
    expect(res.headers()["allow"]).toBe("GET");
  });

  test("an empty database has no run and no repositories", async ({ request }) => {
    const res = await request.get(`${stackUrl("empty")}/api/status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      lastRun: null,
      running: null,
      repos: [],
      summary: { repos: 0, ok: 0, error: 0, pending: 0, withWarnings: 0 },
    });
  });
});

test.describe("GET /api/status with an unreachable database", () => {
  test("is a fixed 503", async ({ request }) => {
    const res = await request.get(`${stackUrl("unreachable")}/api/status`);
    expect(res.status()).toBe(503);
    expect(await res.text()).toBe('{"error":"unavailable"}');
    expect(res.headers()["cache-control"]).toBe("no-store");
  });

  test("/status shows the in-page error state", async ({ page }) => {
    await page.goto(`${stackUrl("unreachable")}/status`);
    await expect(page.getByTestId("status-load-error")).toBeVisible();
  });
});
