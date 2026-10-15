import type { Locator, Page } from "@playwright/test";

import { THEME_TOKENS, type ThemeName } from "../src/lib/theme-tokens";
import { expect, test } from "./support/csp";
import { SEED_REPOS, SEEDED, SEEDED_PRIVATE } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Task 9.2: the home page in a real browser (Chromium), against real databases.
 *
 * - `seeded` (3101): the database filled from `e2e/support/seed-data.ts` through the real
 *   persistence path: public and private repositories (spec: both are listed), the private badge,
 *   the OKF badge, a repository whose last sync failed but still has stored content, a pending
 *   repository, very long names and descriptions.
 * - `empty` (3102): a migrated database without rows: the "Nothing synced yet" state.
 * - `unreachable` (3103): `DATABASE_URL` points at a closed port: the in-page error state. The
 *   response is HTTP 200 because Next.js cannot set a status from a page without throwing; the
 *   layout stays. Unexpected errors go to `src/app/error.tsx` (unit-tested).
 *
 * Seeded and empty specs need Postgres and skip themselves under `E2E_SKIP_DB=1`. Screenshots go
 * to `test-results/` (light and dark) for inspection.
 */

const KEY = "docmyrepos-theme";

const repoName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;

/** Expected grid order: owner then name, byte order of the lower-cased text. */
const EXPECTED_ORDER = SEED_REPOS.map(repoName).sort((a, b) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
});

function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

function card(page: Page, ref: { owner: string; name: string }): Locator {
  return page
    .getByTestId("repo-card")
    .filter({ has: page.getByRole("link", { name: repoName(ref), exact: true }) });
}

async function setTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [KEY, theme],
  );
}

/** Collects what would show up as an error in the browser console, hydration problems included. */
function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

test.describe("home page, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test("lists public and private repositories together, in order, with no browser errors", async ({
    page,
  }) => {
    const errors = collectBrowserErrors(page);
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Documentation portal");
    await expect(page.getByTestId("repo-card")).toHaveCount(SEED_REPOS.length);
    const names = await page
      .getByTestId("repo-card")
      .getByRole("heading", { level: 3 })
      .allTextContents();
    expect(names).toEqual(EXPECTED_ORDER);
    await expect(page.getByRole("heading", { level: 2, name: /^Repositories/ })).toContainText(
      `(${SEED_REPOS.length})`,
    );
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    await expect(page.getByTestId("load-error")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("shows the private badge on private cards only", async ({ page }) => {
    await page.goto("/");
    for (const r of SEED_REPOS) {
      const badge = card(page, r).getByTestId("private-badge");
      if (SEEDED_PRIVATE.includes(repoName(r))) {
        await expect(badge, repoName(r)).toBeVisible();
        await expect(badge).toHaveText("Private");
      } else {
        await expect(badge, repoName(r)).toHaveCount(0);
      }
    }
    await expect(page.getByTestId("private-badge")).toHaveCount(SEEDED_PRIVATE.length);
  });

  test("shows the OKF badge, with the version when the repository declares one", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(card(page, SEEDED.okf).getByTestId("okf-badge")).toHaveText("OKF v0.2");
    // Typed documents but no okf_version: still OKF, no version.
    await expect(card(page, SEEDED.privateOkf).getByTestId("okf-badge")).toHaveText("OKF");
    await expect(card(page, SEEDED.privateOkf).getByTestId("private-badge")).toBeVisible();
    await expect(card(page, SEEDED.full).getByTestId("okf-badge")).toHaveCount(0);
    await expect(page.getByTestId("okf-badge")).toHaveCount(3);
  });

  test("shows description, document count and last synced time on a card", async ({ page }) => {
    await page.goto("/");
    const full = card(page, SEEDED.full);
    await expect(full).toContainText("The public REST API of the platform.");
    await expect(full).toContainText("4 documents");
    const time = full.locator("time");
    await expect(time).toHaveAttribute("datetime", "2026-03-14T09:30:00.000Z");
    await expect(time).toHaveAttribute("title", "14 Mar 2026, 09:30 UTC");
    await expect(time).toContainText(/ago|yesterday|last (month|year)/);
    await expect(time).toContainText("(14 Mar 2026, 09:30 UTC)");
    await expect(card(page, SEEDED.errored)).toContainText("2 documents");
  });

  test("shows the error state on the errored card and keeps its content linked", async ({
    page,
  }) => {
    await page.goto("/");
    const errored = card(page, SEEDED.errored);
    const box = errored.getByTestId("repo-sync-error");
    await expect(box).toBeVisible();
    await expect(box).toContainText("Last sync failed");
    await expect(box).toContainText("GitHub rate limit exhausted; retry later");
    await expect(box).toContainText("Showing previously synced content.");
    await expect(errored).toContainText("2 documents");
    await expect(errored.locator("time")).toHaveAttribute("datetime", "2026-02-01T08:15:00.000Z");
    await expect(errored.getByRole("link")).toHaveAttribute("href", "/acme/flaky-service");
    // No other card shows an error or pending state.
    await expect(page.getByTestId("repo-sync-error")).toHaveCount(1);
  });

  test("shows the pending state for a repository that was never synced", async ({ page }) => {
    await page.goto("/");
    const pending = card(page, SEEDED.pending);
    await expect(pending.getByTestId("repo-pending")).toContainText("Waiting for the first sync");
    await expect(pending).toContainText("Not synced yet");
    await expect(pending).toContainText("No documents");
    await expect(pending.locator("time")).toHaveCount(0);
    await expect(pending.getByRole("link")).toHaveAttribute("href", "/acme/brand-new");
    await expect(page.getByTestId("repo-pending")).toHaveCount(1);
  });

  test("every card has exactly one link, to its repository space", async ({ page }) => {
    await page.goto("/");
    for (const r of SEED_REPOS) {
      const links = card(page, r).locator("a, button, input");
      await expect(links, repoName(r)).toHaveCount(1);
      await expect(links).toHaveAttribute("href", `/${r.owner}/${r.name}`);
    }
  });

  test("clicking anywhere on a card opens its repository space", async ({ page }) => {
    await page.goto("/");
    // The title link's ::after covers the card, so a click anywhere lands on that one anchor.
    await card(page, SEEDED.full).click();
    await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
  });

  test("the search form submits to /search?q=", async ({ page }) => {
    await page.goto("/");
    const form = page.getByRole("search", { name: "Search documentation" });
    await expect(form).toBeVisible();
    await page.getByRole("searchbox", { name: "Search all documentation" }).fill("deploy guide");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(`${stackUrl("seeded")}/search?q=deploy+guide`);
  });

  test("the search query is URL-encoded, whatever the characters", async ({ page }) => {
    await page.goto("/");
    const query = '"unclosed & | ! ( <b> é';
    await page.getByRole("searchbox").fill(query);
    await page.getByRole("searchbox").press("Enter");
    await page.waitForURL(/\/search\?/);
    expect(new URL(page.url()).pathname).toBe("/search");
    expect(new URL(page.url()).searchParams.get("q")).toBe(query);
  });

  test("is keyboard operable: search, then every card in order, Enter opens one", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await page.getByRole("searchbox").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Search" })).toBeFocused();

    for (const name of EXPECTED_ORDER) {
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name, exact: true })).toBeFocused();
    }
    // The first card again, with its focus ring on the whole card.
    const first = page.getByRole("link", { name: EXPECTED_ORDER[0] as string, exact: true });
    await first.focus();
    const ring = await first.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return {
        style: after.outlineStyle,
        width: after.outlineWidth,
        color: after.outlineColor,
        position: after.position,
        inset: [after.top, after.left, after.right, after.bottom],
      };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBe("2px");
    expect(ring.position).toBe("absolute");
    expect(ring.inset).toEqual(["0px", "0px", "0px", "0px"]);
    await page.screenshot({ path: testInfo.outputPath("home-card-focus.png") });

    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
  });

  for (const [label, width, columns] of [
    ["desktop", 1280, 2],
    ["tablet", 800, 2],
    ["phone", 375, 1],
  ] as const) {
    test(`lays out ${columns} column(s) on ${label} without horizontal overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const grid = page.getByRole("list").filter({ has: page.getByTestId("repo-card") });
      const tracks = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
      expect(tracks.split(" ")).toHaveLength(columns);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cards: [...document.querySelectorAll("[data-testid=repo-card]")].map(
          (el) => el.scrollWidth - el.clientWidth,
        ),
      }));
      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(Math.max(...overflow.cards)).toBeLessThanOrEqual(0);
    });
  }

  test("clamps a long description to three lines and shows markup in it as text", async ({
    page,
  }) => {
    await page.goto("/");
    const long = card(page, SEEDED.long);
    const text = long.getByText(/A deliberately long description/);
    const metrics = await text.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        lineHeight: parseFloat(style.lineHeight),
        height: el.getBoundingClientRect().height,
        clipped: el.scrollHeight > el.clientHeight,
      };
    });
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 3 + 1);
    expect(metrics.clipped).toBe(true);
    await expect(long.locator("img, b")).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`renders with the ${theme} tokens`, async ({ page }, testInfo) => {
      // The stored choice wins over the OS preference; make the OS disagree to prove it.
      await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
      await setTheme(page, theme);
      await page.goto("/");
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
      const tokens = THEME_TOKENS[theme];
      const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
      const fg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);

      // Repositories are a ruled list, not boxes: the row carries the card text colour.
      const full = card(page, SEEDED.full);
      expect(await fg(full)).toBe(rgb(tokens["card-foreground"]));
      const badge = card(page, SEEDED.private).getByTestId("private-badge");
      expect(await bg(badge)).toBe(rgb(tokens["private-badge"]));
      expect(await fg(badge)).toBe(rgb(tokens["private-badge-foreground"]));
      const okf = card(page, SEEDED.okf).getByTestId("okf-badge");
      expect(await bg(okf)).toBe(rgb(tokens["okf-badge"]));
      const failed = card(page, SEEDED.errored).getByTestId("repo-sync-error");
      expect(await bg(failed)).toBe(rgb(tokens["destructive-muted"]));
      expect(await fg(failed)).toBe(rgb(tokens["destructive-muted-foreground"]));
      const pending = card(page, SEEDED.pending).getByTestId("repo-pending");
      expect(await bg(pending)).toBe(rgb(tokens.warning));
      expect(await fg(pending)).toBe(rgb(tokens["warning-foreground"]));
      expect(await bg(page.getByRole("button", { name: "Search" }))).toBe(rgb(tokens.foreground));

      await page.screenshot({
        path: testInfo.outputPath(`home-seeded-${theme}.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 375, height: 800 });
      await page.screenshot({
        path: testInfo.outputPath(`home-seeded-${theme}-phone.png`),
        fullPage: true,
      });
    });
  }
});

test.describe("home page, seeded database, without JavaScript", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded"), javaScriptEnabled: false });

  test("lists the repositories and the search form still submits", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("repo-card")).toHaveCount(SEED_REPOS.length);
    await page.getByRole("searchbox").fill("tuning");
    await page.getByRole("searchbox").press("Enter");
    await page.waitForURL(/\/search\?q=tuning$/);
  });
});

test.describe("home page, empty database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("empty") });

  test("explains how to configure and run a first sync", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    const empty = page.getByTestId("empty-state");
    await expect(empty.getByRole("heading", { name: "Nothing synced yet" })).toBeVisible();
    await expect(empty).toContainText("docmyrepos.config.yml");
    await expect(empty).toContainText("GITHUB_APP_INSTALLATION_ID");
    await expect(empty).toContainText("SYNC_SECRET");
    await expect(empty).toContainText(
      'curl -X POST -H "Authorization: Bearer $SYNC_SECRET" <your-app-url>/api/sync',
    );
    await expect(page.getByTestId("repo-card")).toHaveCount(0);
    await expect(page.getByTestId("load-error")).toHaveCount(0);
    // The search bar is still there.
    await expect(page.getByRole("searchbox", { name: "Search all documentation" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`renders with the ${theme} tokens`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
      await setTheme(page, theme);
      await page.goto("/");
      const panel = page.getByTestId("empty-state");
      await expect(panel).toBeVisible();
      expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        rgb(THEME_TOKENS[theme].card),
      );
      await page.screenshot({
        path: testInfo.outputPath(`home-empty-${theme}.png`),
        fullPage: true,
      });
    });
  }
});

test.describe("home page, database unreachable", () => {
  test.use({ baseURL: stackUrl("unreachable") });

  test("keeps the layout and shows a friendly error with a retry link", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const response = await page.goto("/");
    // Decision: the expected failure is rendered by the page, so the response is 200.
    expect(response?.status()).toBe(200);
    const panel = page.getByTestId("load-error");
    await expect(
      panel.getByRole("heading", { name: "Repositories could not be loaded" }),
    ).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("button", { name: "Text size and reading options" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Documentation portal");
    await expect(page.getByRole("searchbox")).toBeVisible();
    await expect(page.getByTestId("repo-card")).toHaveCount(0);
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    const retry = panel.getByRole("link", { name: "Try again" });
    await expect(retry).toHaveAttribute("href", "/");
    // Only a fixed text reaches the browser: no connection string, host, port or user.
    const html = await page.content();
    expect(html).not.toMatch(/postgres(ql)?:|ECONNREFUSED|127\.0\.0\.1|docmyrepos:|password/i);
    expect(errors).toEqual([]);

    await retry.click();
    await expect(page).toHaveURL(`${stackUrl("unreachable")}/`);
    await expect(panel).toBeVisible();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`renders with the ${theme} tokens`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
      await setTheme(page, theme);
      await page.goto("/");
      const panel = page.getByTestId("load-error");
      await expect(panel).toBeVisible();
      const tokens = THEME_TOKENS[theme];
      expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        rgb(tokens["destructive-muted"]),
      );
      expect(
        await panel
          .getByRole("link", { name: "Try again" })
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe(rgb(tokens.primary));
      await page.screenshot({
        path: testInfo.outputPath(`home-error-${theme}.png`),
        fullPage: true,
      });
    });
  }
});
