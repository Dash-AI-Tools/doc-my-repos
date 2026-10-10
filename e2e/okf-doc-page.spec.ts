import { expect, test, type Locator, type Page } from "@playwright/test";

import { type ThemeName } from "../src/lib/theme-tokens";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Tasks 11.4 to 11.6: the OKF metadata card, the deprecation, draft and stale notices, and the
 * change log, on the document page, in a real browser (Chromium) against the seeded database.
 *
 * `acme/okf-showcase` is the OKF repository these documents live in (the data is described in the
 * header of e2e/support/seed-data.ts); `acme/api-service` is plain Markdown. The seeded dates are
 * far from today (2020-01-01 is always past, 2999-01-01 always future), so no clock hook is needed.
 * Screenshots go to `test-results/` (light and dark) for inspection.
 */

const KEY = "docmyrepos-theme";
const SHOW = SEEDED.okfShowcase;
const PLAIN = SEEDED.full;
const SHOW_PATH = `/${SHOW.owner}/${SHOW.name}`;
const doc = (stem: string): string => `${SHOW_PATH}/docs/${stem}`;

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

const card = (page: Page): Locator => page.getByTestId("okf-metadata");
const row = (page: Page, name: string): Locator => page.getByTestId(`okf-row-${name}`);
const notice = (page: Page, kind: string): Locator => page.getByTestId(`okf-notice-${kind}`);

test.describe("OKF document page, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("metadata card (11.4)", () => {
    test("shows every field of a fully described document", async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await page.goto(doc("concepts/full-metadata"));
      await expect(page.getByRole("heading", { level: 1, name: "Full metadata" })).toBeVisible();
      await expect(card(page)).toBeVisible();
      await expect(card(page).getByRole("heading", { name: "Document metadata" })).toBeVisible();

      await expect(page.getByTestId("okf-type")).toHaveText("Metric");
      await expect(page.getByTestId("okf-status")).toHaveText("active");
      await expect(page.getByTestId("okf-tag")).toHaveText(["finance", "quarterly"]);
      await expect(page.getByTestId("okf-description")).toHaveText(
        "A metric that carries every field the card shows.",
      );
      // the description is in the card, not repeated under the title
      await expect(page.getByTestId("doc-description")).toHaveCount(0);

      await expect(row(page, "generated")).toContainText("15 Jan 2026");
      await expect(row(page, "generated").locator("time")).toHaveAttribute(
        "datetime",
        "2026-01-15",
      );
      await expect(row(page, "verified")).toContainText("20 Feb 2026, 10:30 UTC");
      await expect(row(page, "stale-after")).toContainText("1 Jan 2999");
      await expect(row(page, "stale-after")).toContainText("(in ");

      // the producer's key is listed
      const other = page.getByTestId("okf-other-fields");
      await expect(other.getByRole("heading", { name: "Other fields" })).toBeVisible();
      await expect(other).toContainText("owner_team");
      await expect(other).toContainText("platform");
      expect(errors).toEqual([]);
    });

    test("links the resource and sources to external pages, and leaves a local path as text", async ({
      page,
    }) => {
      await page.goto(doc("concepts/full-metadata"));
      const resource = row(page, "resource").getByRole("link");
      await expect(resource).toHaveAttribute("href", "https://example.com/metrics/full");
      await expect(resource).toHaveAttribute("rel", /noopener/);
      await expect(resource).toHaveAttribute("rel", /noreferrer/);
      const sources = row(page, "sources");
      const links = sources.getByRole("link");
      await expect(links).toHaveCount(2);
      await expect(links.nth(0)).toHaveAttribute("href", "https://example.com/source-one");
      await expect(links.nth(1)).toHaveText("Audit report");
      await expect(links.nth(1)).toHaveAttribute("href", "https://example.com/audit");
      for (const i of [0, 1]) await expect(links.nth(i)).toHaveAttribute("rel", /noopener/);
      await expect(sources.getByTestId("okf-ref-text")).toHaveText("docs/local-notes.md");
    });

    test("links the type, status and tags to the repository filters", async ({ page }) => {
      await page.goto(doc("concepts/full-metadata"));
      await expect(page.getByTestId("okf-type")).toHaveAttribute(
        "href",
        `${SHOW_PATH}?type=Metric`,
      );
      await expect(page.getByTestId("okf-tag").first()).toHaveAttribute(
        "href",
        `${SHOW_PATH}?tag=finance`,
      );
      await page.getByTestId("okf-type").click();
      await expect(page).toHaveURL(new RegExp(`${SHOW_PATH}\\?type=Metric$`));
      await expect(page.getByTestId("okf-filter-summary")).toHaveText("4 of 10 documents match");
    });

    test("shows only the type for a document that declares nothing else", async ({ page }) => {
      await page.goto(doc("concepts/type-only"));
      await expect(card(page)).toBeVisible();
      await expect(page.getByTestId("okf-type")).toHaveText("Note");
      await expect(card(page).locator("dt")).toHaveText(["Type"]);
      await expect(page.getByTestId("okf-other-fields")).toHaveCount(0);
      await expect(page.getByTestId("okf-notices")).toHaveCount(0);
      const text = (await card(page).textContent()) ?? "";
      expect(text).not.toMatch(/undefined|null|N\/A/);
    });

    test("shows no card for a document with no frontmatter", async ({ page }) => {
      await page.goto(doc("guides/untyped-note"));
      await expect(page.getByRole("heading", { level: 1, name: "Untyped note" })).toBeVisible();
      await expect(card(page)).toHaveCount(0);
    });

    test("lists unknown keys of every shape as text, and never links a hostile URL", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      await page.goto(doc("concepts/odd-keys"));
      const other = page.getByTestId("okf-other-fields");
      // more than five fields: collapsed behind a native details element
      await expect(other).toHaveJSProperty("tagName", "DETAILS");
      await expect(other).not.toHaveAttribute("open", "");
      await other.locator("summary").click();
      const fields = other.getByTestId("okf-other-field");
      // Postgres JSONB keeps keys sorted by length, then bytes, not in authoring order.
      await expect(fields.locator(":scope > dt")).toHaveText([
        "list",
        "long",
        "count",
        "markup",
        "nested",
        "enabled",
        "nothing",
        "owner_team",
      ]);
      await expect(fields.filter({ hasText: "level2" })).toContainText("deep value");
      await expect(fields.filter({ hasText: "count" }).first()).toContainText("42");
      await expect(fields.filter({ hasText: "enabled" })).toContainText("false");
      await expect(fields.filter({ hasText: "nothing" })).toContainText("null");
      await expect(fields.filter({ hasText: "list" })).toContainText("alpha");
      // markup-looking text is text
      await expect(fields.filter({ hasText: "markup" })).toContainText(
        "<img src=x onerror=alert(1)>",
      );
      await expect(card(page).locator("img, script")).toHaveCount(0);
      expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
      // a long string is shortened
      const longText = (await fields.filter({ hasText: "lorem ipsum" }).textContent()) ?? "";
      expect(longText.length).toBeLessThan(700);
      expect(longText).toContain("…");

      // hostile resource and sources: only the safe URL is a link
      const links = card(page).getByTestId("okf-ref-link");
      await expect(links).toHaveCount(1);
      await expect(links).toHaveAttribute("href", "https://example.com/safe-source");
      await expect(row(page, "resource")).toContainText("javascript:alert(1)");
      await expect(row(page, "resource").getByRole("link")).toHaveCount(0);
      await expect(card(page).locator("a[href^='javascript'], a[href^='data']")).toHaveCount(0);
      await expect(row(page, "sources")).toContainText("../escape.md");
      await expect(row(page, "sources")).toContainText(
        "https://user:secret@example.com/credentials",
      );
      expect(errors).toEqual([]);
    });

    test("shows a date that cannot be read as written, with a hint", async ({ page }) => {
      await page.goto(doc("concepts/bad-dates"));
      await expect(row(page, "generated")).toContainText("2026-02-30");
      await expect(row(page, "generated")).toContainText("(not a valid date)");
      await expect(row(page, "verified")).toContainText("yesterday");
      await expect(row(page, "stale-after")).toContainText("next quarter");
      await expect(row(page, "stale-after")).toContainText("(not a valid date)");
      await expect(card(page).locator("time")).toHaveCount(0);
    });

    test("shows no OKF UI on a page of a plain Markdown repository", async ({ page }) => {
      await page.goto(`/${PLAIN.owner}/${PLAIN.name}/docs/guides/setup`);
      await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
      await expect(card(page)).toHaveCount(0);
      await expect(page.getByTestId("okf-notices")).toHaveCount(0);
      await expect(page.getByTestId("change-log")).toHaveCount(0);
      await expect(page.getByTestId("docs-tree-label")).toHaveCount(0);
      await expect(page.getByTestId("okf-filters")).toHaveCount(0);
    });
  });

  test.describe("notices (11.5)", () => {
    test("shows a deprecation notice above the content", async ({ page }) => {
      await page.goto(doc("concepts/deprecated-metric"));
      const n = notice(page, "deprecated");
      await expect(n).toBeVisible();
      await expect(n).toHaveAttribute("role", "note");
      await expect(n).toContainText("This document is deprecated.");
      await expect(notice(page, "stale")).toHaveCount(0);
      // above the body
      const above = await page.evaluate(() => {
        const a = document.querySelector("[data-testid=okf-notice-deprecated]");
        const b = document.querySelector("[data-testid=doc-body]");
        return (
          a !== null &&
          b !== null &&
          a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top
        );
      });
      expect(above).toBe(true);
      // the status chip shows the status as written
      await expect(page.getByTestId("okf-status")).toHaveText("deprecated");
    });

    test("shows a draft notice", async ({ page }) => {
      await page.goto(doc("concepts/draft-metric"));
      await expect(notice(page, "draft")).toContainText("This document is a draft.");
      await expect(notice(page, "deprecated")).toHaveCount(0);
    });

    test("warns with the date when stale_after is in the past", async ({ page }) => {
      await page.goto(doc("concepts/stale-metric"));
      const n = notice(page, "stale");
      await expect(n).toBeVisible();
      await expect(n).toContainText("This document may be out of date");
      await expect(n).toContainText("1 Jan 2020");
      await expect(n).toContainText(/\d+ years ago/);
      await expect(n.locator("time")).toHaveAttribute("datetime", "2020-01-01");
      await expect(row(page, "stale-after")).toContainText("years ago)");
    });

    test("does not warn when stale_after is in the future", async ({ page }) => {
      await page.goto(doc("guides/fresh"));
      await expect(card(page)).toBeVisible();
      await expect(row(page, "stale-after")).toContainText("1 Jan 2999");
      await expect(page.getByTestId("okf-notices")).toHaveCount(0);
      await expect(page.getByRole("note")).toHaveCount(0);
    });

    test("does not warn for a date that cannot be read", async ({ page }) => {
      await page.goto(doc("concepts/bad-dates"));
      await expect(page.getByTestId("okf-notices")).toHaveCount(0);
    });

    test("stacks a deprecation and a stale warning, matching the status in any case", async ({
      page,
    }) => {
      await page.goto(doc("concepts/stale-deprecated"));
      await expect(page.getByTestId("okf-status")).toHaveText("Deprecated");
      await expect(page.getByTestId("okf-notices").getByRole("note")).toHaveCount(2);
      await expect(notice(page, "deprecated")).toBeVisible();
      await expect(notice(page, "stale")).toBeVisible();
      // status first
      const order = await page
        .getByTestId("okf-notices")
        .getByRole("note")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
      expect(order).toEqual(["okf-notice-deprecated", "okf-notice-stale"]);
    });
  });

  test.describe("change log and reserved files (11.6)", () => {
    test("shows log.md as a change log: labelled, in order, with no metadata card", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      await page.goto(doc("log"));
      const log = page.getByTestId("change-log");
      await expect(log).toBeVisible();
      await expect(page.getByTestId("change-log-badge")).toHaveText("Change log");
      await expect(log).toContainText("not a typed concept");
      await expect(log.getByRole("heading", { level: 2 })).toHaveText(["2026-03-20", "2026-03-10"]);
      await expect(card(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("labels log.md in the table of contents, and index.md has no label or card", async ({
      page,
    }) => {
      await page.goto(SHOW_PATH);
      const labels = page.getByTestId("docs-tree").getByTestId("docs-tree-label");
      await expect(labels).toHaveText(["Change log"]);
      // the link keeps the page title; the label is next to it
      await expect(
        page.getByTestId("docs-tree").getByRole("link", { name: "Log", exact: true }),
      ).toBeVisible();

      await page.goto(doc("index"));
      await expect(page.getByRole("heading", { level: 1, name: "Showcase" })).toBeVisible();
      await expect(card(page)).toHaveCount(0);
      await expect(page.getByTestId("change-log")).toHaveCount(0);
    });

    test("keeps index.md and log.md out of the type counts and out of a type filter", async ({
      page,
    }) => {
      await page.goto(SHOW_PATH);
      const types = page.getByTestId("okf-filter-type").getByTestId("okf-filter-chip");
      await expect(types).toHaveText([
        "Metric 4 documents",
        "Policy 2 documents",
        "Experiment 1 document",
        "Guide 1 document",
        "Note 1 document",
      ]);
      // total of type counts equals the typed documents (9 of 10; the untyped note has no type)
      await page.goto(`${SHOW_PATH}?type=Metric&type=Policy&type=Experiment&type=Guide&type=Note`);
      await expect(page.getByTestId("okf-filter-summary")).toHaveText("9 of 10 documents match");
      const shown = await page.getByTestId("docs-tree").getByRole("link").allTextContents();
      expect(shown).not.toContain("Log");
      expect(shown).not.toContain("Showcase");
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`renders the card, notices and change log in the ${theme} theme`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await setTheme(page, theme);
      const shots: [string, string, string][] = [
        ["full", "concepts/full-metadata", "okf-metadata"],
        ["type-only", "concepts/type-only", "okf-metadata"],
        ["odd-keys", "concepts/odd-keys", "okf-metadata"],
        ["stale-deprecated", "concepts/stale-deprecated", "okf-notice-stale"],
        ["draft", "concepts/draft-metric", "okf-notice-draft"],
        ["bad-dates", "concepts/bad-dates", "okf-metadata"],
        ["log", "log", "change-log"],
      ];
      for (const [name, stem, wait] of shots) {
        await page.goto(doc(stem));
        await expect(page.getByTestId(wait)).toBeVisible();
        if (name === "odd-keys")
          await page.getByTestId("okf-other-fields").locator("summary").click();
        await page.screenshot({
          path: `test-results/okf-doc-${name}-${theme}.png`,
          fullPage: true,
        });
      }
      // the notices and the card are painted with distinct, non-transparent backgrounds
      await page.goto(doc("concepts/stale-deprecated"));
      const colours = await page.evaluate(() => {
        const bg = (id: string) => {
          const el = document.querySelector(`[data-testid=${id}]`);
          return el === null ? null : getComputedStyle(el).backgroundColor;
        };
        return {
          deprecated: bg("okf-notice-deprecated"),
          stale: bg("okf-notice-stale"),
          card: bg("okf-metadata"),
        };
      });
      expect(colours.deprecated).not.toBe(colours.stale);
      expect(colours.deprecated).not.toBe("rgba(0, 0, 0, 0)");
      expect(colours.stale).not.toBe("rgba(0, 0, 0, 0)");
      expect(colours.card).not.toBe("rgba(0, 0, 0, 0)");
      expect(errors).toEqual([]);
    });

    test(`keeps the card readable on a narrow screen in the ${theme} theme`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(doc("concepts/odd-keys"));
      await page.getByTestId("okf-other-fields").locator("summary").click();
      await expect(card(page)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
      await page.screenshot({ path: `test-results/okf-doc-mobile-${theme}.png` });
    });
  }
});
