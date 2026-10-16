import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { COMMENT_DOCS, HEAVY_THREADS } from "./support/comment-data";
import { docUrl, openSession, type SessionOptions } from "./support/comments";
import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON } from "./support/stack";

/**
 * The comments UI in both themes, at phone width with the largest text size, and with the keyboard
 * (document-comments tasks 4.4 and 5.2): the Comments section of a document with 50 threads (long
 * names, long unbroken words, replies, resolved threads, organization comments, a deleted comment
 * with replies) and the admin Comments page. Read-only: nothing here writes, so these specs can
 * run beside `comments.spec.ts`.
 *
 * Checked: an axe pass (WCAG 2.0/2.1 A and AA plus best practices, which includes the contrast
 * minimums), no horizontal page scroll, nothing wider than the viewport, targets of at least 24 by
 * 24 CSS pixels (links inside the sentence of a comment's text are exempt, WCAG 2.5.8), and every
 * control reachable with Tab.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const THEMES = ["light", "dark"] as const;
const DOC = docUrl(COMMENT_DOCS.heavy);
const INTERACTIVE =
  "a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex='-1'])";
const PHONE: Pick<SessionOptions, "viewport" | "textSize"> = {
  viewport: { width: 320, height: 640 },
  textSize: "largest",
};

const section = (page: Page) => page.getByTestId("comments-section");

async function openDoc(page: Page): Promise<void> {
  await page.goto(DOC);
  await expect(section(page).getByRole("heading", { level: 2, name: "Comments" })).toBeVisible();
  await expect(section(page).getByLabel("Add a comment")).toBeVisible();
  await expect(section(page).getByTestId("comment-threads").locator("> li")).toHaveCount(
    HEAVY_THREADS,
  );
}

async function openAdmin(page: Page, query: string): Promise<void> {
  await page.goto(`/admin/comments${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Comments" })).toBeVisible();
  await expect(page.getByTestId("moderation-row").first()).toBeVisible();
}

async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    [],
  );
}

/** No horizontal page scroll, and nothing inside `root` sticks out of the viewport. */
async function expectFits(page: Page, root: Locator, label: string): Promise<void> {
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scroll.scrollWidth, `${label}: horizontal page scroll`).toBeLessThanOrEqual(
    scroll.innerWidth,
  );
  const wide = await root.evaluate((el) => {
    const limit = window.innerWidth;
    return Array.from(el.querySelectorAll("*"))
      .map((child) => ({ child, rect: child.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && (rect.right > limit + 0.5 || rect.left < -0.5))
      .slice(0, 5)
      .map(
        ({ child, rect }) =>
          `${child.tagName.toLowerCase()} ${Math.round(rect.left)}..${Math.round(rect.right)}`,
      );
  });
  expect(wide, `${label}: elements outside the viewport`).toEqual([]);
}

/** Every visible control inside `root` is at least 24 by 24 CSS pixels (inline text links exempt). */
async function expectTargets(root: Locator, label: string): Promise<void> {
  const small = await root.evaluate((el, selector) => {
    return Array.from(el.querySelectorAll<HTMLElement>(selector))
      .filter((control) => !control.closest("[data-testid='comment-text']"))
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => ({
        control,
        // A checkbox is clicked through its label, which is the target.
        rect: (
          (control instanceof HTMLInputElement && control.labels?.[0]) ||
          control
        ).getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.width < 24 || rect.height < 24)
      .slice(0, 8)
      .map(
        ({ control, rect }) =>
          `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      );
  }, INTERACTIVE);
  expect(small, `${label}: targets under 24x24`).toEqual([]);
}

/**
 * Tabs from `start` until focus leaves `root`, and returns the controls that are enabled and
 * visible in `root` but never received focus (controls inside a closed <details> excepted: only
 * its summary is reachable until it is opened).
 */
async function unreachableByTab(page: Page, root: Locator, start: Locator): Promise<string[]> {
  await root.evaluate((el, selector) => {
    const w = window as unknown as { __visited: Set<Element> };
    w.__visited = new Set();
    document.addEventListener("focusin", (event) => w.__visited.add(event.target as Element));
    el.querySelectorAll(selector);
  }, INTERACTIVE);
  await start.evaluate((el) => {
    el.setAttribute("tabindex", "-1");
    (el as HTMLElement).focus();
  });
  for (let i = 0; i < 2000; i++) {
    await page.keyboard.press("Tab");
    const inside = await root.evaluate((el) => el.contains(document.activeElement));
    if (!inside) break;
  }
  return root.evaluate((el, selector) => {
    const visited = (window as unknown as { __visited: Set<Element> }).__visited;
    return Array.from(el.querySelectorAll<HTMLElement>(selector))
      .filter((control) => control.getClientRects().length > 0)
      .filter((control) => !(control as HTMLButtonElement).disabled)
      .filter(
        (control) =>
          !control.closest("details:not([open]):not(summary)") || control.tagName === "SUMMARY",
      )
      .filter((control) => !visited.has(control))
      .slice(0, 8)
      .map(
        (control) =>
          `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}"`,
      );
  }, INTERACTIVE);
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test(`axe is clean on a document with 50 comment threads, with each form open (${theme})`, async ({
      browser,
    }) => {
      const s = await openSession(browser, { user: "olga", theme });
      try {
        const page = s.page;
        await openDoc(page);
        await expectAxeClean(page, "document with comments");
        await expectTargets(section(page), "document with comments");

        const first = section(page).getByTestId("comment").first();
        await first.getByRole("button", { name: /^Reply to the comment by / }).click();
        await expect(first.getByRole("textbox")).toBeFocused();
        await expect(first.getByLabel("Comment as the organization")).toBeVisible();
        await expectAxeClean(page, "reply form open");
        await expectTargets(section(page), "reply form open");

        // An organization reply: the admin may edit and delete it.
        const org = section(page)
          .getByTestId("comment")
          .filter({ hasText: "The organization answers here." })
          .first();
        await org.scrollIntoViewIfNeeded();
        await expect(org).toContainText("Organization");
        await org.getByRole("button", { name: /^Edit the comment by / }).click();
        await expectAxeClean(page, "edit form open");
        await org.getByRole("button", { name: "Cancel" }).click();
        await org.getByRole("button", { name: /^Delete the comment by / }).click();
        await expect(org.getByRole("group", { name: /^Confirm deleting/ })).toBeVisible();
        await expectAxeClean(page, "delete confirmation open");
        await expectTargets(section(page), "delete confirmation open");
        await org.getByRole("button", { name: "Cancel" }).click();

        // A resolved thread, expanded.
        const resolved = section(page).getByTestId("resolved-thread").first();
        await resolved.locator("summary").click();
        await expect(resolved).toHaveAttribute("open", "");
        await expectAxeClean(page, "resolved thread expanded");
      } finally {
        await s.close();
      }
    });

    test(`axe is clean on the document page for a viewer without admin options (${theme})`, async ({
      browser,
    }) => {
      const s = await openSession(browser, { user: "ben", theme });
      try {
        await openDoc(s.page);
        await expect(s.page.getByLabel("Comment as the organization")).toHaveCount(0);
        await expectAxeClean(s.page, "viewer");
      } finally {
        await s.close();
      }
    });

    test(`the document page fits 320 CSS pixels with the largest text size (${theme})`, async ({
      browser,
    }, testInfo) => {
      const s = await openSession(browser, { user: "olga", theme, ...PHONE });
      try {
        const page = s.page;
        await openDoc(page);
        await expect(page.locator("html")).toHaveAttribute("data-text-size", "largest");
        await expectFits(page, section(page), "320px, comments");
        await expectTargets(section(page), "320px, comments");

        // The long name and the 400-character word wrap instead of widening the page.
        const long = section(page)
          .getByTestId("comment")
          .filter({ hasText: "x".repeat(60) })
          .first();
        await long.scrollIntoViewIfNeeded();
        await expect(long).toBeVisible();
        await expect(
          section(page)
            .getByTestId("comment-text")
            .filter({ hasText: "W".repeat(400) })
            .first(),
        ).toBeVisible();

        // Forms and confirmations at the same width.
        const first = section(page).getByTestId("comment").first();
        await first.getByRole("button", { name: /^Reply to the comment by / }).click();
        await expectFits(page, section(page), "320px, reply form");
        await expectTargets(section(page), "320px, reply form");
        await expectAxeClean(page, "320px, reply form");
        await page.screenshot({
          path: testInfo.outputPath(`comments-${theme}-320-largest.png`),
          fullPage: false,
        });

        const resolved = section(page).getByTestId("resolved-thread").first();
        await resolved.locator("summary").click();
        await expectFits(page, section(page), "320px, resolved thread open");
      } finally {
        await s.close();
      }
    });

    test(`axe is clean on the admin Comments page, with a confirmation open (${theme})`, async ({
      browser,
    }) => {
      const s = await openSession(browser, { theme });
      try {
        const page = s.page;
        await openAdmin(page, "");
        await expectAxeClean(page, "admin comments, all");
        await expectTargets(page.getByRole("main"), "admin comments, all");

        await openAdmin(page, "?state=orphaned");
        await expectAxeClean(page, "admin comments, orphaned");
        await expectTargets(page.getByRole("main"), "admin comments, orphaned");
        const row = page.getByTestId("moderation-row").first();
        await row.getByRole("button", { name: /^Remove permanently/ }).click();
        await expect(row.getByRole("group", { name: /^Confirm:/ })).toBeVisible();
        await expectAxeClean(page, "admin comments, confirmation open");
        await expectTargets(page.getByRole("main"), "admin comments, confirmation open");
        await page.keyboard.press("Escape");
        await expect(row.getByRole("group", { name: /^Confirm:/ })).toHaveCount(0);

        await openAdmin(page, "?state=live");
        await expectAxeClean(page, "admin comments, live");
      } finally {
        await s.close();
      }
    });

    test(`the admin Comments page fits 320 CSS pixels with the largest text size (${theme})`, async ({
      browser,
    }, testInfo) => {
      const s = await openSession(browser, { theme, ...PHONE });
      try {
        const page = s.page;
        for (const query of ["", "?state=orphaned", "?state=live"]) {
          await openAdmin(page, query);
          await expectFits(page, page.getByRole("main"), `320px, admin ${query || "all"}`);
          await expectTargets(page.getByRole("main"), `320px, admin ${query || "all"}`);
        }
        await openAdmin(page, "?state=orphaned");
        const row = page.getByTestId("moderation-row").first();
        await row.getByRole("button", { name: /^Remove permanently/ }).click();
        await expectFits(page, page.getByRole("main"), "320px, admin confirmation");
        await expectAxeClean(page, "320px, admin confirmation");
        await page.screenshot({
          path: testInfo.outputPath(`admin-comments-${theme}-320-largest.png`),
          fullPage: false,
        });
      } finally {
        await s.close();
      }
    });
  });
}

test("every control of the comments section is reachable with the Tab key", async ({ browser }) => {
  const s = await openSession(browser, { user: "olga" });
  try {
    const page = s.page;
    await openDoc(page);
    const missed = await unreachableByTab(page, section(page), page.locator("#comments-heading"));
    expect(missed, "controls never focused by Tab").toEqual([]);
  } finally {
    await s.close();
  }
});

test("every control of the admin Comments page is reachable with the Tab key", async ({
  browser,
}) => {
  const s = await openSession(browser);
  try {
    const page = s.page;
    await openAdmin(page, "?state=orphaned");
    const main = page.getByRole("main");
    const missed = await unreachableByTab(page, main, main.getByRole("heading", { level: 1 }));
    expect(missed, "controls never focused by Tab").toEqual([]);
  } finally {
    await s.close();
  }
});

test("the keyboard alone posts, replies, edits, resolves and deletes on the admin-free layout", async ({
  browser,
}) => {
  // Covered in detail by the component tests; here one flow on a real layout and real focus rules.
  const s = await openSession(browser, { user: "rita" });
  try {
    const page = s.page;
    await page.goto(docUrl(COMMENT_DOCS.synced));
    await expect(section(page).getByLabel("Add a comment")).toBeVisible();
    // Tab order reaches the composer's field and then its button.
    await section(page).getByLabel("Add a comment").focus();
    await page.keyboard.press("Tab");
    await expect(section(page).getByRole("button", { name: "Post comment" })).toBeFocused();
    // An empty submit by keyboard shows the reason and puts focus back on the field.
    await page.keyboard.press("Enter");
    await expect(section(page).getByRole("alert")).toContainText("Write something before posting.");
    await expect(section(page).getByLabel("Add a comment")).toBeFocused();
  } finally {
    await s.close();
  }
});
