import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import type { ThemeName } from "../packages/core/src/theme-tokens";
import { expect, test } from "./support/csp";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Reading aids (reading-accessibility 4.1, and the browser checks of 1.2, 1.7, 3.2 and 3.4): read
 * mode and the text size, in Chromium against the seeded database (`acme/doc-showcase`).
 *
 * The text size lives in a cookie and an attribute on <html>, so each test starts from a fresh
 * context. The theme is set through the same local storage key the theme spec uses.
 */

const THEME_KEY = "docmyrepos-theme";
const SHOWCASE = `/${SEEDED.showcase.owner}/${SEEDED.showcase.name}`;
const OVERVIEW = `${SHOWCASE}/docs/overview`;
const LONG = `${SHOWCASE}/docs/guides/long-outline`;
const GETTING_STARTED = `${SHOWCASE}/docs/guides/getting-started`;

const SIZES = [
  { label: /^Small \(/, percent: 87.5 },
  { label: /^Default \(/, percent: 100 },
  { label: /^Large \(/, percent: 112.5 },
  { label: /^Larger \(/, percent: 125 },
  { label: /^Largest \(/, percent: 150 },
] as const;

async function setTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [THEME_KEY, theme],
  );
}

const aa = (page: Page): Locator =>
  page.getByRole("button", { name: "Text size and reading options" }).first();
async function pressR(page: Page): Promise<void> {
  await expect(page.locator("[data-read-toggle]").first()).toBeAttached();
  await page.keyboard.press("r");
}

const readButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Read mode", exact: true });
const shortcutBox = (page: Page): Locator =>
  page.getByRole("checkbox", { name: "Press R for read mode" });
const exitButton = (page: Page): Locator => page.getByRole("button", { name: "Exit read mode" });
const article = (page: Page): Locator => page.getByTestId("doc-article");

/** Opens the text size panel and chooses a size by its label. */
async function chooseSize(page: Page, label: RegExp): Promise<void> {
  await aa(page).click();
  const index = ["Small", "Default", "Large", "Larger", "Largest"].findIndex((name) =>
    label.test(`${name} (`),
  );
  await page.getByRole("slider", { name: /^Text size/ }).fill(String(index));
  await page.keyboard.press("Escape");
}

/** Whether read mode is on, from the page's own attribute. */
const readModeOn = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.dataset.readMode === "true");

test.describe("reading aids, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("read mode", () => {
    test("R and the button turn it on and off on a document", async ({ page }) => {
      await page.goto(OVERVIEW);
      await pressR(page);
      expect(await readModeOn(page)).toBe(true);
      await expect(exitButton(page)).toBeVisible();
      await expect(readButton(page)).toBeHidden();

      await pressR(page);
      expect(await readModeOn(page)).toBe(false);

      await aa(page).click();
      await readButton(page).click();
      expect(await readModeOn(page)).toBe(true);
    });

    test("does nothing on the home page: no button and R is ignored", async ({ page }) => {
      await page.goto("/");
      await aa(page).click();
      await expect(readButton(page)).toHaveCount(0);
      await page.keyboard.press("r");
      expect(await readModeOn(page)).toBe(false);
    });

    test("Ctrl+R is left to the browser", async ({ page }) => {
      await page.goto(OVERVIEW);
      await page.locator("body").click();
      await page.keyboard.press("Control+r");
      await page.waitForLoadState("load");
      expect(await readModeOn(page)).toBe(false);
    });

    test("typing r in the search palette is not intercepted", async ({ page }) => {
      await page.goto(OVERVIEW);
      await expect(aa(page)).toBeVisible();
      await page.keyboard.press("Control+k");
      const search = page.getByRole("combobox").or(page.getByRole("searchbox")).first();
      await search.focus();
      await page.keyboard.type("r");
      await expect(search).toHaveValue("r");
      expect(await readModeOn(page)).toBe(false);
    });

    test("Escape exits read mode", async ({ page }) => {
      await page.goto(OVERVIEW);
      await pressR(page);
      await page.keyboard.press("Escape");
      expect(await readModeOn(page)).toBe(false);
    });

    test("the shortcut checkbox disables R but not the button or Escape", async ({ page }) => {
      await page.goto(OVERVIEW);
      await aa(page).click();
      await shortcutBox(page).uncheck();
      await aa(page).click();

      await pressR(page);
      expect(await readModeOn(page)).toBe(false);

      await aa(page).click();
      await readButton(page).click();
      expect(await readModeOn(page)).toBe(true);
      await page.keyboard.press("Escape");
      expect(await readModeOn(page)).toBe(false);
    });

    test("focus moves into the article and returns to the reading button", async ({ page }) => {
      await page.goto(OVERVIEW);
      await pressR(page);
      await expect(article(page)).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(aa(page)).toBeFocused();
    });

    test("announces the change to screen readers", async ({ page }) => {
      await page.goto(OVERVIEW);
      const status = page.getByRole("status").filter({ hasText: "Read mode" });
      await pressR(page);
      await expect(status).toHaveText("Read mode on. Press R or Escape to exit.");
      await pressR(page);
      await expect(status).toHaveText("Read mode off.");
    });

    test("keeps the reader's place in a long document", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(LONG);
      const blocks = "h1, h2, h3, h4, h5, h6, p, pre, table, ul, ol, blockquote, figure";
      await page.evaluate(
        (selector) =>
          document
            .querySelectorAll("[data-read-article] " + selector)[40]
            ?.scrollIntoView({ block: "center" }),
        blocks,
      );
      const firstVisible = () =>
        page.evaluate((selector) => {
          const all = [...document.querySelectorAll("[data-read-article] " + selector)];
          const index = all.findIndex((el) => {
            const box = el.getBoundingClientRect();
            return box.bottom > 0 && box.top < window.innerHeight;
          });
          return { index, top: all[index]?.getBoundingClientRect().top ?? NaN };
        }, blocks);

      const before = await firstVisible();
      await pressR(page);
      const after = await page.evaluate(
        ({ selector, index }) =>
          document
            .querySelectorAll("[data-read-article] " + selector)
            [index]?.getBoundingClientRect().top ?? NaN,
        { selector: blocks, index: before.index },
      );
      expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2);
    });

    test("survives a link to another document, and a load starts it off", async ({ page }) => {
      await page.goto(GETTING_STARTED);
      await pressR(page);
      await page
        .getByRole("link", { name: /next|previous/i })
        .first()
        .click();
      await page.waitForURL(/\/docs\//);
      expect(await readModeOn(page)).toBe(true);

      await page.reload();
      expect(await readModeOn(page)).toBe(false);
    });

    test("hides the chrome and keeps the column centred and capped", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(OVERVIEW);
      await pressR(page);

      await expect(page.locator("header[data-read-hide]")).toBeHidden();
      await expect(page.locator("footer[data-read-hide]")).toBeHidden();
      await expect(page.getByTestId("doc-sidebar")).toBeHidden();
      await expect(page.getByTestId("doc-breadcrumb")).toBeHidden();

      const column = await page.locator(".reader-content").boundingBox();
      expect(column).not.toBeNull();
      expect(column?.width ?? 0).toBeLessThanOrEqual(44 * 16 + 1);
      const left = column?.x ?? 0;
      const right = 1280 - (left + (column?.width ?? 0));
      expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    });

    test("drops the header heights to zero", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(OVERVIEW);
      await pressR(page);
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--site-header-h").trim(),
          ),
        )
        .toMatch(/^0(px)?$/);
    });

    test("hidden parts are not reachable by keyboard", async ({ page }) => {
      await page.goto(OVERVIEW);
      await pressR(page);
      const reachable = await page.evaluate(
        () =>
          [...document.querySelectorAll("[data-read-hide]")].filter(
            (el) => getComputedStyle(el).display !== "none",
          ).length,
      );
      expect(reachable).toBe(0);
    });
  });

  test.describe("text size", () => {
    test("each size applies to the computed root and persists across reloads", async ({ page }) => {
      await page.goto(OVERVIEW);
      const rootSize = () =>
        page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      const base = await rootSize();

      for (const size of SIZES) {
        await chooseSize(page, size.label);
        expect(await rootSize()).toBeCloseTo((base * size.percent) / 100, 1);
      }

      await chooseSize(page, /^Largest \(/);
      await page.reload();
      expect(await rootSize()).toBeCloseTo(base * 1.5, 1);
    });

    test("the server HTML already carries the size, so the first paint is right", async ({
      page,
    }) => {
      await page.goto(OVERVIEW);
      await chooseSize(page, /^Larger \(/);
      const cookies = await page.context().cookies();
      const response = await page.request.get(stackUrl("seeded") + OVERVIEW, {
        headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
      });
      expect(await response.text()).toMatch(/<html[^>]*data-text-size="larger"/);
    });

    test("choosing Default clears the cookie", async ({ page }) => {
      await page.goto(OVERVIEW);
      await chooseSize(page, /^Largest \(/);
      await chooseSize(page, /^Default \(/);
      const cookies = await page.context().cookies();
      expect(cookies.find((c) => c.name === "docmyrepos-text-size")).toBeUndefined();
    });

    test("a garbage cookie falls back to Default", async ({ page, context }) => {
      await context.addCookies([
        { name: "docmyrepos-text-size", value: "huge", url: stackUrl("seeded") },
      ]);
      await page.goto(OVERVIEW);
      await expect(page.locator("html")).not.toHaveAttribute("data-text-size", /.+/);
    });

    test("the sign-in page has the text size control", async ({ page }) => {
      await page.goto("/login");
      await expect(aa(page)).toBeVisible();
    });

    test("sample elements grow with the step, not only the root", async ({ page }) => {
      await page.goto(OVERVIEW);
      const sample = () =>
        page.evaluate((): [number, number] => {
          const title = document.getElementById("doc-title");
          const link = document.querySelector("header a[href='/']");
          const size = (el: Element | null) =>
            parseFloat(getComputedStyle(el ?? document.body).fontSize);
          return [size(title), size(link)];
        });
      const [titleBase, linkBase] = await sample();
      await chooseSize(page, /^Largest \(/);
      const [titleLarge, linkLarge] = await sample();
      expect(titleLarge / titleBase).toBeCloseTo(1.5, 1);
      expect(linkLarge / linkBase).toBeCloseTo(1.5, 1);
    });
  });

  test.describe("layout and accessibility, Largest", () => {
    test("the document column stays at least 20rem wide on three columns", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(OVERVIEW);
      await chooseSize(page, /^Largest \(/);
      const box = await article(page).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(20 * 16 * 1.5);
    });

    test("controls are at least 24 by 24 CSS pixels in the header", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.goto(OVERVIEW);
      await chooseSize(page, /^Largest \(/);
      const buttons = page.locator("header button:visible");
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const box = await buttons.nth(i).boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
      }
    });

    for (const width of [320, 768, 1024, 1280, 1920]) {
      test(`no sideways page scroll at ${width}px, Largest`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(OVERVIEW);
        await chooseSize(page, /^Largest \(/);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }

    for (const theme of ["light", "dark"] as const) {
      test(`axe passes in ${theme}, Largest and in read mode`, async ({ page }) => {
        await setTheme(page, theme);
        await page.goto(OVERVIEW);
        await chooseSize(page, /^Largest \(/);
        const normal = await new AxeBuilder({ page }).analyze();
        expect(normal.violations).toEqual([]);

        await pressR(page);
        const reading = await new AxeBuilder({ page }).analyze();
        expect(reading.violations).toEqual([]);
      });
    }
  });
});

test.describe("layout matrix and read mode at phone width, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  const PAGES = [
    { name: "home", path: "/" },
    { name: "repository", path: SHOWCASE },
    { name: "document", path: OVERVIEW },
    { name: "search", path: "/search?q=setup" },
    { name: "sign-in", path: "/login" },
  ] as const;

  for (const { name, path } of PAGES) {
    for (const width of [320, 768, 1024, 1280, 1920]) {
      test(`${name} has no sideways scroll at ${width}px, Largest`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.evaluate(() =>
          document.documentElement.setAttribute("data-text-size", "largest"),
        );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }
  }

  test("read mode at 320px keeps the page within the width and off the title", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(OVERVIEW);
    await chooseSize(page, /^Largest \(/);
    await pressR(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const title = await page.locator("#doc-title").boundingBox();
    const bar = await page.getByRole("complementary", { name: "Reading controls" }).boundingBox();
    expect(title).not.toBeNull();
    expect(bar).not.toBeNull();
    const overlaps =
      bar !== null &&
      title !== null &&
      bar.x < title.x + title.width &&
      bar.x + bar.width > title.x &&
      bar.y < title.y + title.height &&
      bar.y + bar.height > title.y;
    expect(overlaps).toBe(false);
  });

  test("read mode has no transition with reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(OVERVIEW);
    await pressR(page);
    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector("article") as Element).transitionDuration,
    );
    expect(duration.split(",").every((value) => parseFloat(value) === 0)).toBe(true);
  });
});
