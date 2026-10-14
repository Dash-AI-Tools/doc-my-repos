import type { Locator, Page } from "@playwright/test";

import { type ThemeName } from "../src/lib/theme-tokens";
import { expect, test } from "./support/csp";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Tasks 11.1 to 11.3: the OKF badge and the type, tag and status filters of the docs table of
 * contents, in a real browser (Chromium) against the seeded database.
 *
 * `acme/knowledge-base` is the OKF repository (12 documents plus `index.md` and `log.md`; the
 * counts are listed in the header of e2e/support/seed-data.ts), `acme/api-service` is plain
 * Markdown. Screenshots go to `test-results/` (light and dark) for inspection.
 */

const KEY = "docmyrepos-theme";
const KB = SEEDED.okf; // acme/knowledge-base
const PLAIN = SEEDED.full; // acme/api-service
const KB_PATH = `/${KB.owner}/${KB.name}`;
const PLAIN_PATH = `/${PLAIN.owner}/${PLAIN.name}`;

type Kind = "type" | "tag" | "status";

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

const filters = (page: Page): Locator => page.getByTestId("okf-filters");
const group = (page: Page, kind: Kind): Locator => page.getByTestId(`okf-filter-${kind}`);
const tree = (page: Page): Locator => page.getByTestId("docs-tree");
const summary = (page: Page): Locator => page.getByTestId("okf-filter-summary");

/** The chip of `kind` whose label is exactly `label` (the label is followed by " <n> document(s)"). */
function chip(page: Page, kind: Kind, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return group(page, kind).getByRole("link", { name: new RegExp(`^${escaped} \\d+ documents?`) });
}

/** `[label, count]` of every chip of a group in the order shown (hidden "Show more" chips too). */
async function counts(page: Page, kind: Kind): Promise<[string, number][]> {
  const rows = await group(page, kind)
    .getByTestId("okf-filter-chip")
    .evaluateAll((els) =>
      els.map((el) => [
        el.querySelector("span.min-w-0")?.textContent ?? "",
        Number(el.querySelector("[data-testid=okf-filter-count]")?.firstChild?.textContent),
      ]),
    );
  return rows as [string, number][];
}

/** The document links shown in the tree (the page links, not the folder buttons), by title. */
async function shown(page: Page): Promise<string[]> {
  return (await tree(page).getByRole("link").allTextContents()).sort();
}

/** The tree is replaced after the URL changes (history navigation too): poll, do not read once. */
async function expectShown(page: Page, titles: string[]): Promise<void> {
  await expect.poll(() => shown(page)).toEqual(titles);
}

async function expectCounts(page: Page, kind: Kind, expected: [string, number][]): Promise<void> {
  await expect.poll(() => counts(page, kind)).toEqual(expected);
}

const ALL_TITLES = [
  "Billing",
  "Customers",
  "Failover",
  "Invoices table",
  "Knowledge base",
  "Log",
  "Meeting notes",
  "Release pipeline",
  "Restore",
  "Rollback",
  "Tax",
  "Terms",
  "Use Postgres",
  "Use queues",
];

test.describe("OKF badge and table of contents filters, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("OKF badge (11.1)", () => {
    test("shows on the card, the repo header and the filters of an OKF repository", async ({
      page,
    }) => {
      await page.goto("/");
      const card = page.getByTestId("repo-card").filter({ hasText: "knowledge-base" });
      await expect(card.getByTestId("okf-badge")).toHaveText("OKF v0.2");
      await page.goto(KB_PATH);
      await expect(page.getByTestId("repo-header").getByTestId("okf-badge")).toHaveText("OKF v0.2");
      await expect(filters(page)).toBeVisible();
    });

    test("a plain repository shows no OKF UI on its card, header, table of contents or documents", async ({
      page,
    }) => {
      await page.goto("/");
      const card = page.getByTestId("repo-card").filter({ hasText: "api-service" });
      await expect(card.getByTestId("okf-badge")).toHaveCount(0);
      for (const path of [PLAIN_PATH, `${PLAIN_PATH}/docs/guides/setup`]) {
        await page.goto(path);
        await expect(page.getByTestId("docs-nav")).toBeVisible();
        await expect(page.getByTestId("okf-badge")).toHaveCount(0);
        await expect(filters(page)).toHaveCount(0);
        await expect(page.getByTestId("okf-filter-chip")).toHaveCount(0);
        await expect(page.getByText(/OKF/)).toHaveCount(0);
        await expect(page.getByText("Filter documents")).toHaveCount(0);
      }
    });

    test("a plain repository ignores stray filter parameters: no error, the whole tree, no filter UI", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      for (const path of [PLAIN_PATH, `${PLAIN_PATH}/docs/guides/setup`]) {
        const response = await page.goto(`${path}?type=Concept&tag=core&status=draft`);
        expect(response?.status()).toBe(200);
        await expect(page.getByTestId("docs-nav")).toBeVisible();
        await expect(filters(page)).toHaveCount(0);
        await expect(page.getByTestId("docs-nav-no-match")).toHaveCount(0);
        await expect(tree(page).getByRole("link", { name: "Setup", exact: true })).toBeVisible();
        // Links of the tree carry no filter either.
        await expect(tree(page).getByRole("link", { name: "Setup", exact: true })).toHaveAttribute(
          "href",
          `${PLAIN_PATH}/docs/guides/setup`,
        );
      }
      expect(errors).toEqual([]);
    });

    test("the search page shows only the Repository facet for plain results", async ({ page }) => {
      await page.goto(`/search?q=tuning`);
      await expect(page.getByTestId("result")).toHaveCount(1);
      await expect(page.getByTestId("facet-group-repo")).toBeVisible();
      for (const kind of ["type", "tag", "status"]) {
        await expect(page.getByTestId(`facet-group-${kind}`)).toHaveCount(0);
      }
    });
  });

  test.describe("type filter (11.2)", () => {
    test("lists the types with counts, exactly as authored and never merged", async ({ page }) => {
      await page.goto(KB_PATH);
      await expectCounts(page, "type", [
        ["Runbook", 3],
        ["concept", 3],
        ["Decision", 2],
        ["Table", 2],
        ["Concept", 1],
      ]);
      // index.md, log.md and the untyped note are not typed concepts: 11 typed documents.
      const total = (await counts(page, "type")).reduce((sum, [, n]) => sum + n, 0);
      expect(total).toBe(11);
      // The whole tree, with nothing selected.
      await expectShown(page, ALL_TITLES);
      await expect(summary(page)).toHaveCount(0);
      await expect(page.getByTestId("okf-filter-clear")).toHaveCount(0);
    });

    test("selecting a type narrows the tree to those documents and their folders", async ({
      page,
    }) => {
      await page.goto(KB_PATH);
      await chip(page, "type", "Runbook").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook`);
      await expect(summary(page)).toHaveText("3 of 12 documents match");
      await expectShown(page, ["Failover", "Restore", "Rollback"]);
      // Folders without a match are gone; the folder with the matches is open.
      await expect(
        tree(page).getByRole("button", { name: "runbooks", exact: true }),
      ).toHaveAttribute("aria-expanded", "true");
      for (const name of ["concepts", "data", "decisions", "glossary", "notes"]) {
        await expect(tree(page).getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      // Selected state in text and attribute.
      await expect(chip(page, "type", "Runbook")).toHaveAttribute("aria-current", "true");
      await expect(chip(page, "type", "Runbook")).toContainText("selected, press to remove");
      await expect(chip(page, "type", "Table")).not.toHaveAttribute("aria-current", "true");
      // The other types stay listed with their counts (disjunctive); tags and statuses are
      // counted among the selected documents.
      expect((await counts(page, "type")).map(([l]) => l)).toEqual([
        "Runbook",
        "concept",
        "Decision",
        "Table",
        "Concept",
      ]);
      await expectCounts(page, "tag", [
        ["database", 2],
        ["oncall", 2],
        ["infrastructure", 1],
      ]);
      await expectCounts(page, "status", [
        ["active", 1],
        ["deprecated", 1],
        ["draft", 1],
      ]);
    });

    test("Concept and concept are separate values and separate filters", async ({ page }) => {
      await page.goto(KB_PATH);
      await chip(page, "type", "concept").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=concept`);
      await expectShown(page, ["Billing", "Release pipeline", "Tax"]);
      await chip(page, "type", "concept").click(); // off
      await expect(page).toHaveURL(KB_PATH);
      await chip(page, "type", "Concept").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=Concept`);
      await expectShown(page, ["Terms"]);
    });

    test("several types are OR-ed", async ({ page }) => {
      await page.goto(KB_PATH);
      await chip(page, "type", "Runbook").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook`);
      await chip(page, "type", "Table").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook&type=Table`);
      await expectShown(page, ["Customers", "Failover", "Invoices table", "Restore", "Rollback"]);
      await expect(summary(page)).toHaveText("5 of 12 documents match");
    });

    test("removing the selection, by chip or by the clear link, restores the whole tree", async ({
      page,
    }) => {
      await page.goto(`${KB_PATH}?type=Runbook&tag=oncall`);
      await expectShown(page, ["Failover", "Rollback"]);
      // The selected chip is a toggle.
      await chip(page, "tag", "oncall").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook`);
      await expectShown(page, ["Failover", "Restore", "Rollback"]);
      await page.getByTestId("okf-filter-clear").click();
      await expect(page).toHaveURL(KB_PATH);
      await expectShown(page, ALL_TITLES);
      await expect(filters(page)).toBeVisible();
      await expect(summary(page)).toHaveCount(0);
    });

    test("says nothing matches, with a way out, when the filters match no document", async ({
      page,
    }) => {
      await page.goto(`${KB_PATH}?type=Runbook&tag=glossary`);
      const none = page.getByTestId("docs-nav-no-match");
      await expect(none).toContainText("No documents match these filters");
      await expect(summary(page)).toHaveText("0 of 12 documents match");
      await expect(tree(page)).toHaveCount(0);
      await expect(page.getByTestId("docs-nav-empty")).toHaveCount(0);
      await none.getByRole("link", { name: "Clear filters" }).click();
      await expect(page).toHaveURL(KB_PATH);
      await expectShown(page, ALL_TITLES);
    });

    test("a value that does not exist is listed (count 0) so it can be removed", async ({
      page,
    }) => {
      await page.goto(`${KB_PATH}?type=Nope`);
      await expect(chip(page, "type", "Nope")).toHaveAttribute("aria-current", "true");
      await expect(chip(page, "type", "Nope")).toContainText("0 documents");
      await chip(page, "type", "Nope").click();
      await expect(page).toHaveURL(KB_PATH);
    });

    test("is operable from the keyboard and keeps focus on the chip", async ({ page }) => {
      await page.goto(KB_PATH);
      const runbook = chip(page, "type", "Runbook");
      await runbook.focus();
      await expect(runbook).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook`);
      await expectShown(page, ["Failover", "Restore", "Rollback"]);
      await expect(runbook).toBeFocused();
      // Tab moves to the next chip, Enter adds it.
      await page.keyboard.press("Tab");
      await expect(chip(page, "type", "concept")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook&type=concept`);
      await expect(chip(page, "type", "concept")).toBeFocused();
    });
  });

  test.describe("tag and status filters, combined, in the URL (11.3)", () => {
    test("lists tags and statuses with counts; a long tag list has 'Show more'", async ({
      page,
    }) => {
      await page.goto(KB_PATH);
      await expectCounts(page, "tag", [
        ["database", 5],
        ["finance", 4],
        ["infrastructure", 3],
        ["oncall", 2],
        ["billing", 1],
        ["deployment", 1],
        ["glossary", 1],
      ]);
      await expectCounts(page, "status", [
        ["active", 6],
        ["draft", 3],
        ["deprecated", 2],
      ]);
      const more = page.getByTestId("okf-filter-more-tag");
      await expect(more).toContainText("Show 1 more");
      await expect(chip(page, "tag", "glossary")).toBeHidden();
      await more.locator(":scope > summary").click();
      await expect(chip(page, "tag", "glossary")).toBeVisible();
      await chip(page, "tag", "glossary").click();
      await expect(page).toHaveURL(`${KB_PATH}?tag=glossary`);
      await expectShown(page, ["Terms"]);
      // A selected chip stays visible without opening 'Show more'.
      await expect(chip(page, "tag", "glossary")).toBeVisible();
    });

    test("type, tag and status combine: AND across kinds, and the URL keeps them in order", async ({
      page,
    }) => {
      await page.goto(KB_PATH);
      await chip(page, "type", "concept").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=concept`);
      await expectShown(page, ["Billing", "Release pipeline", "Tax"]);

      await chip(page, "tag", "finance").click();
      await expect(page).toHaveURL(`${KB_PATH}?tag=finance&type=concept`);
      await expectShown(page, ["Billing", "Tax"]);
      await expect(summary(page)).toHaveText("2 of 12 documents match");

      await chip(page, "status", "draft").click();
      await expect(page).toHaveURL(`${KB_PATH}?status=draft&tag=finance&type=concept`);
      await expectShown(page, ["Tax"]);
      await expect(summary(page)).toHaveText("1 of 12 documents match");
      // Counts reflect the other filters: the type group shows only types with a draft finance doc.
      await expectCounts(page, "type", [["concept", 1]]);
      // Options within a kind are OR-ed: add a second status.
      await chip(page, "status", "active").click();
      await expect(page).toHaveURL(
        `${KB_PATH}?status=active&status=draft&tag=finance&type=concept`,
      );
      await expectShown(page, ["Billing", "Tax"]);
    });

    test("a reload restores the filters, the tree and the selected chips", async ({ page }) => {
      await page.goto(KB_PATH);
      await chip(page, "type", "Runbook").click();
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook`);
      await chip(page, "status", "active").click();
      await expect(page).toHaveURL(`${KB_PATH}?status=active&type=Runbook`);
      await expectShown(page, ["Failover"]);

      await page.reload();
      await expect(page).toHaveURL(`${KB_PATH}?status=active&type=Runbook`);
      await expectShown(page, ["Failover"]);
      await expect(chip(page, "type", "Runbook")).toHaveAttribute("aria-current", "true");
      await expect(chip(page, "status", "active")).toHaveAttribute("aria-current", "true");
      await expect(chip(page, "status", "draft")).not.toHaveAttribute("aria-current", "true");
      await expect(summary(page)).toHaveText("1 of 12 documents match");

      // Back and forward move between the states.
      await page.goBack();
      await expect(page).toHaveURL(`${KB_PATH}?type=Runbook`);
      await expectShown(page, ["Failover", "Restore", "Rollback"]);
    });

    test("a filtered URL opens the same state in a new browser context (shareable)", async ({
      page,
      browser,
    }) => {
      const url = `${KB_PATH}?status=draft&tag=finance&type=concept`;
      await page.goto(url);
      await expectShown(page, ["Tax"]);
      const other = await browser.newContext({ baseURL: stackUrl("seeded") });
      try {
        const copy = await other.newPage();
        await copy.goto(url);
        await expectShown(copy, ["Tax"]);
        await expect(chip(copy, "type", "concept")).toHaveAttribute("aria-current", "true");
        await expect(chip(copy, "tag", "finance")).toHaveAttribute("aria-current", "true");
        await expect(chip(copy, "status", "draft")).toHaveAttribute("aria-current", "true");
      } finally {
        await other.close();
      }
    });

    test("odd URLs never break the page: unknown values, bad escapes, duplicates, huge values", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      for (const query of [
        "type=Runbook&type=Runbook&type=Runbook",
        "type=&tag=&status=",
        `tag=${"x".repeat(2000)}`,
        "type=%E3%81%82%F0%9F%A6%84",
        "status=a%00b",
        "type=Runbook&limit=5&page=9&q=ignored&repo=acme/api-service",
      ]) {
        const response = await page.goto(`${KB_PATH}?${query}`);
        expect(response?.status(), query).toBe(200);
        await expect(page.getByTestId("docs-nav"), query).toBeVisible();
      }
      // Duplicates collapse; unrelated parameters are ignored and dropped from the chip links.
      await page.goto(`${KB_PATH}?type=Runbook&type=Runbook&q=ignored&page=3`);
      await expectShown(page, ["Failover", "Restore", "Rollback"]);
      await expect(chip(page, "tag", "database")).toHaveAttribute(
        "href",
        `${KB_PATH}?tag=database&type=Runbook`,
      );
      expect(errors).toEqual([]);
    });
  });

  test.describe("document page sidebar", () => {
    const DOC = `${KB_PATH}/docs/concepts/billing`;

    test("shows the same filters, narrows the sidebar, and keeps the current page", async ({
      page,
    }) => {
      await page.goto(DOC);
      await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
      await expect(filters(page)).toBeVisible();
      await chip(page, "type", "Runbook").click();
      await expect(page).toHaveURL(`${DOC}?type=Runbook`);
      // Billing is a `concept`: it does not match but stays, marked as the current page.
      await expectShown(page, ["Billing", "Failover", "Restore", "Rollback"]);
      await expect(tree(page).locator('a[aria-current="page"]')).toHaveText("Billing");
      await expect(summary(page)).toHaveText("3 of 12 documents match");
    });

    test("keeps the filters while moving between documents through the sidebar", async ({
      page,
    }) => {
      await page.goto(`${DOC}?type=Runbook`);
      await tree(page).getByRole("link", { name: "Failover", exact: true }).click();
      await expect(page).toHaveURL(`${KB_PATH}/docs/runbooks/failover?type=Runbook`);
      await expect(page.getByRole("heading", { level: 1, name: "Failover" })).toBeVisible();
      await expectShown(page, ["Failover", "Restore", "Rollback"]);
      await expect(chip(page, "type", "Runbook")).toHaveAttribute("aria-current", "true");
    });

    test("previous and next ignore the filters", async ({ page }) => {
      await page.goto(`${KB_PATH}/docs/runbooks/failover`);
      const without = await page.getByTestId("doc-pager").getByRole("link").allTextContents();
      await page.goto(`${KB_PATH}/docs/runbooks/failover?type=Table&tag=finance`);
      const withFilters = await page.getByTestId("doc-pager").getByRole("link").allTextContents();
      expect(withFilters).toEqual(without);
    });

    test("a deep link with filters survives a reload and a case-variant redirect", async ({
      page,
    }) => {
      await page.goto(`${DOC}?type=Table&tag=finance`);
      await expectShown(page, ["Billing", "Customers", "Invoices table"]);
      await page.reload();
      await expectShown(page, ["Billing", "Customers", "Invoices table"]);
      await page.goto(`/ACME/Knowledge-Base/docs/concepts/billing?type=Table`);
      await expect(page).toHaveURL(`${DOC}?type=Table`);
      await expect(chip(page, "type", "Table")).toHaveAttribute("aria-current", "true");
    });
  });

  test.describe("private OKF repository", () => {
    test("shows its own types, not those of other repositories", async ({ page }) => {
      await page.goto(`/${SEEDED.privateOkf.owner}/${SEEDED.privateOkf.name}`);
      await expect(page.getByTestId("okf-badge")).toHaveText("OKF");
      await expectCounts(page, "type", [["policy", 2]]);
      await chip(page, "type", "policy").click();
      await expect(page.getByTestId("okf-filter-summary")).toHaveText("2 of 2 documents match");
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`renders the filters in the ${theme} theme`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await setTheme(page, theme);
      await page.goto(KB_PATH);
      await expect(filters(page)).toBeVisible();
      await page.screenshot({ path: `test-results/okf-filters-none-${theme}.png`, fullPage: true });

      await page.goto(`${KB_PATH}?status=active&type=Runbook&type=Table`);
      await expect(summary(page)).toHaveText("2 of 12 documents match");
      // A selected chip is filled with the primary colour; an unselected one is not.
      const colours = await page.evaluate(() => {
        const pick = (selected: string) => {
          const el = document.querySelector(
            `[data-testid=okf-filter-chip][data-selected="${selected}"]`,
          );
          const s = el === null ? null : getComputedStyle(el);
          return s === null ? null : { background: s.backgroundColor, color: s.color };
        };
        return { on: pick("true"), off: pick("false") };
      });
      expect(colours.on).not.toBeNull();
      expect(colours.off).not.toBeNull();
      expect(colours.on?.background).not.toBe(colours.off?.background);
      await page.screenshot({
        path: `test-results/okf-filters-selected-${theme}.png`,
        fullPage: true,
      });

      await page.goto(`${KB_PATH}?type=Runbook&tag=glossary`);
      await expect(page.getByTestId("docs-nav-no-match")).toBeVisible();
      await page.screenshot({
        path: `test-results/okf-filters-empty-${theme}.png`,
        fullPage: true,
      });

      await page.goto(`${KB_PATH}/docs/concepts/billing?type=Runbook`);
      await expect(filters(page)).toBeVisible();
      await page.screenshot({ path: `test-results/okf-filters-doc-${theme}.png`, fullPage: true });
      expect(errors).toEqual([]);
    });

    test(`keeps the filters usable on a narrow screen in the ${theme} theme`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(`${KB_PATH}/docs/concepts/billing?type=Runbook`);
      await page.getByTestId("docs-nav").locator("summary").first().click();
      await expect(filters(page)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
      await page.screenshot({ path: `test-results/okf-filters-mobile-${theme}.png` });
    });
  }
});
