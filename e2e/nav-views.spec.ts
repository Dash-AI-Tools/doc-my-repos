import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";

import { NAV_VIEW_COOKIE } from "../packages/core/src/reading-prefs";
import { type ThemeName } from "../packages/core/src/theme-tokens";
import { expect, test } from "./support/csp";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * docs-nav-views: the OKF / Tree selector at the top of an OKF repository's docs structure, in a
 * real browser against the seeded database.
 *
 * `acme/knowledge-base` is OKF. In the Tree view its docs folder reads, in path order:
 * concepts/ (billing, release-pipeline, tax), data/ (customers, invoices), decisions/
 * (use-postgres, use-queues), glossary/ (terms), notes/ (meeting), runbooks/ (failover, restore,
 * rollback), then index and log. `acme/okf-showcase` is a second OKF repository and
 * `acme/api-service` is plain Markdown. Screenshots go to `test-results/` for the PR notes.
 */

const KB = SEEDED.okf;
const SHOWCASE = SEEDED.okfShowcase;
const PLAIN = SEEDED.full;
const KB_PATH = `/${KB.owner}/${KB.name}`;
const TAX = `${KB_PATH}/docs/concepts/tax`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

const TREE_ORDER = [
  "billing",
  "release-pipeline",
  "tax",
  "customers",
  "invoices",
  "use-postgres",
  "use-queues",
  "terms",
  "meeting",
  "failover",
  "restore",
  "rollback",
  "index",
  "log",
];

const nav = (page: Page): Locator => page.getByRole("navigation", { name: "Documentation" });
const selector = (page: Page): Locator => page.getByRole("group", { name: "Navigation view" });
const viewButton = (page: Page, name: "OKF" | "Tree"): Locator =>
  selector(page).getByRole("button", { name, exact: true });

/** Every page link of the tree, in document order, including those in closed folders. */
async function treeEntries(page: Page): Promise<string[]> {
  return page
    .getByTestId("docs-tree")
    .locator("a")
    .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
}

async function chooseTree(page: Page): Promise<void> {
  await viewButton(page, "Tree").click();
  await expect(viewButton(page, "Tree")).toHaveAttribute("aria-pressed", "true");
}

async function setTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("docmyrepos-theme", value), theme);
}

async function navCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((c) => c.name === NAV_VIEW_COOKIE)?.value;
}

test.describe("docs navigation views", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test("the selector is the first control of the left column, with OKF active by default", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(KB_PATH);
    await expect(selector(page)).toBeVisible();
    const first = await nav(page).evaluate(
      (el) => el.querySelector("button, a, input:not([type=hidden])")?.textContent,
    );
    expect(first).toBe("OKF");
    await expect(viewButton(page, "OKF")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("okf-filters")).toBeVisible();
    const selectorBox = await selector(page).boundingBox();
    const labelBox = await nav(page).getByText("Documentation", { exact: true }).boundingBox();
    expect(selectorBox!.y).toBeLessThan(labelBox!.y);
  });

  test("Tree shows file names in path order, keeps the document marked, and is remembered", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(TAX);
    await expect(nav(page).getByRole("link", { name: "Tax", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await chooseTree(page);

    await expect.poll(() => treeEntries(page)).toEqual(TREE_ORDER);
    await expect(page.getByTestId("okf-filters")).toHaveCount(0);
    await expect(page.getByTestId("docs-tree-label")).toHaveCount(0);
    await expect(nav(page).getByRole("link", { name: "tax", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page).toHaveURL(TAX);
    expect(await navCookie(context)).toBe("tree");

    // Previous/next follow the path order and keep titles.
    const pager = page.getByTestId("doc-pager");
    await expect(pager.locator('a[rel="prev"]')).toHaveAttribute(
      "href",
      `${KB_PATH}/docs/concepts/release-pipeline`,
    );
    await expect(pager.locator('a[rel="next"]')).toHaveAttribute(
      "href",
      `${KB_PATH}/docs/data/customers`,
    );
    await expect(pager.locator('a[rel="next"]')).toContainText("Customers");

    // The server already renders the remembered view: no OKF structure first.
    const response = await page.request.get(TAX);
    const html = await response.text();
    expect(html).toContain('data-testid="nav-view-tree"');
    expect(html).toMatch(
      /data-testid="nav-view-tree"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="nav-view-tree"/,
    );
    expect(html).not.toContain('data-testid="okf-filters"');

    await page.reload();
    await expect(viewButton(page, "Tree")).toHaveAttribute("aria-pressed", "true");

    // Another OKF repository opens in Tree too.
    await page.goto(`/${SHOWCASE.owner}/${SHOWCASE.name}`);
    await expect(viewButton(page, "Tree")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("okf-filters")).toHaveCount(0);

    await page.screenshot({ path: "test-results/nav-views-tree-light.png", fullPage: false });

    // Back to OKF: titles and filters return, and the cookie is cleared.
    await page.goto(TAX);
    await viewButton(page, "OKF").click();
    await expect(viewButton(page, "OKF")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("okf-filters")).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Tax", exact: true })).toBeVisible();
    expect(await navCookie(context)).toBeUndefined();
  });

  test("Tree ignores a type filter in the address; OKF applies it again", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${KB_PATH}?type=Table`);
    await chooseTree(page);
    await expect.poll(() => treeEntries(page)).toEqual(TREE_ORDER);
    await viewButton(page, "OKF").click();
    await expect(page.getByTestId("okf-filters")).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId("docs-tree").locator("a").allTextContents()).sort())
      .toEqual(["Customers", "Invoices table"]);
  });

  test("a repository that is not OKF shows no selector, even with a Tree choice", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: NAV_VIEW_COOKIE, value: "tree", url: stackUrl("seeded") }]);
    await page.goto(`/${PLAIN.owner}/${PLAIN.name}`);
    await expect(nav(page)).toBeVisible();
    await expect(selector(page)).toHaveCount(0);
  });

  test("an unknown stored value shows OKF", async ({ page, context }) => {
    await context.addCookies([
      { name: NAV_VIEW_COOKIE, value: "sideways", url: stackUrl("seeded") },
    ]);
    await page.goto(KB_PATH);
    await expect(viewButton(page, "OKF")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("okf-filters")).toBeVisible();
  });

  test("on a phone the panel stays open with focus inside after switching", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(TAX);
    await page.getByTestId("doc-nav-toggle").click();
    const panel = page.locator("#doc-nav-panel");
    await expect(page.getByTestId("doc-nav-wrap")).toHaveAttribute("data-open", "true");
    // Right under the Close button.
    const close = await page.getByTestId("doc-nav-close").boundingBox();
    const group = await selector(page).boundingBox();
    expect(group!.y).toBeGreaterThan(close!.y);
    await chooseTree(page);
    await expect.poll(() => treeEntries(page)).toEqual(TREE_ORDER);
    await expect(page.getByTestId("doc-nav-wrap")).toHaveAttribute("data-open", "true");
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: "test-results/nav-views-panel-light.png" });
  });

  test("works without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: stackUrl("seeded"),
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto(TAX);
    await expect(viewButton(page, "OKF")).toHaveAttribute("aria-pressed", "true");
    await viewButton(page, "Tree").click();
    await expect(viewButton(page, "Tree")).toHaveAttribute("aria-pressed", "true");
    expect(await treeEntries(page)).toEqual(TREE_ORDER);
    expect(await navCookie(context)).toBe("tree");
    await context.close();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`passes axe in both views on the repository and document pages (${theme})`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const view of ["OKF", "Tree"] as const) {
        for (const path of [KB_PATH, TAX]) {
          await page.goto(path);
          if (
            view === "Tree" &&
            (await viewButton(page, "Tree").getAttribute("aria-pressed")) !== "true"
          ) {
            await chooseTree(page);
          }
          await expect(viewButton(page, view)).toHaveAttribute("aria-pressed", "true");
          const results = await new AxeBuilder({ page })
            .include('nav[aria-label="Documentation"]')
            .withTags(TAGS)
            .analyze();
          expect(results.violations, `${view} ${path}`).toEqual([]);
        }
      }
      await page.screenshot({ path: `test-results/nav-views-${theme}.png` });
    });
  }

  for (const width of [320, 768, 1024, 1440]) {
    test(`the selector fits at ${width}px with touch-sized buttons and no sideways scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(TAX);
      if (width < 1024) await page.getByTestId("doc-nav-toggle").click();
      for (const name of ["OKF", "Tree"] as const) {
        const box = await viewButton(page, name).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(32);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
