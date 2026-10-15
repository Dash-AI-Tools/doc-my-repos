import type { Locator, Page } from "@playwright/test";

import { THEME_TOKENS, type ThemeName } from "../src/lib/theme-tokens";
import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Task 10.4: the global command palette (Ctrl+K / Cmd+K) in a real browser (Chromium) against the
 * seeded database (e2e/support/seed-data.ts). "deployment" matches 10 documents in 5 repositories
 * (title first: acme/search-lab "Deployment"), the palette shows the best 8. "onboarding" finds
 * only a document of a private repository; "gateway" finds the document with a hostile title.
 *
 * Screenshots (light and dark, desktop and mobile) go to `test-results/palette-*.png` for
 * inspection.
 */

const KEY = "docmyrepos-theme";
const PAGES = [
  ["home", "/"],
  ["repo page", "/acme/api-service"],
  ["doc page", "/acme/api-service/docs/guides/setup"],
  ["search page", "/search?q=deployment"],
] as const;

async function setTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [KEY, theme],
  );
}

/** What would show up as an error in the browser console, hydration problems included. */
function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const dialog = (page: Page): Locator => page.getByRole("dialog", { name: "Quick search" });
const input = (page: Page): Locator => page.getByRole("combobox");
const options = (page: Page): Locator => page.getByRole("option");
const trigger = (page: Page): Locator => page.getByTestId("palette-trigger");
const status = (page: Page): Locator => page.getByTestId("palette-status");

async function openPalette(page: Page, key = "Control+k"): Promise<void> {
  await page.keyboard.press(key);
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}

/** Types like a visitor, then waits for the list (or the settled count) to be on screen. */
async function search(page: Page, text: string, rows?: number): Promise<void> {
  await input(page).pressSequentially(text);
  if (rows !== undefined) await expect(options(page)).toHaveCount(rows);
}

/**
 * Opens a page and waits until it is hydrated: the shortcut listener is attached by React, so a
 * key pressed earlier is simply lost (the header trigger is a plain link until then). The theme
 * toggle swaps its placeholder for the real control on mount, which marks hydration.
 */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
}

const optionTitles = (page: Page): Promise<string[]> =>
  page.getByTestId("palette-title").allTextContents();

test.describe("command palette, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("opening", () => {
    for (const [pageName, path] of PAGES) {
      for (const key of ["Control+k", "Meta+k"]) {
        test(`${key} opens it on the ${pageName} with the input focused`, async ({ page }) => {
          const errors = collectBrowserErrors(page);
          await visit(page, path);
          await expect(trigger(page)).toBeVisible();
          await openPalette(page, key);
          // empty query: hints, no list, nothing requested
          await expect(page.getByTestId("palette-hint")).toBeVisible();
          await expect(options(page)).toHaveCount(0);
          await expect(input(page)).toHaveAttribute("aria-expanded", "false");
          await page.keyboard.press("Escape");
          await expect(dialog(page)).toBeHidden();
          expect(errors).toEqual([]);
        });
      }
    }

    test("the header trigger is a link to /search that opens it, and has the shortcut hint", async ({
      page,
    }) => {
      await visit(page, "/");
      await expect(trigger(page)).toHaveAttribute("href", "/search");
      await expect(trigger(page)).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
      await expect(trigger(page)).toContainText("Search");
      // Chromium on Linux/Windows runs here: the hint says Ctrl K (the Cmd swap is unit-tested)
      await expect(page.getByTestId("palette-shortcut")).toHaveText(/^(Ctrl K|⌘K)$/);
      await trigger(page).click();
      await expect(dialog(page)).toBeVisible();
      await expect(input(page)).toBeFocused();
    });

    test("the header's tab order is logo, main navigation, search trigger, theme toggle", async ({
      page,
    }) => {
      await visit(page, "/");
      await page.locator("header a").first().focus();
      const mainLinks = await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link")
        .count();
      for (let i = 0; i < mainLinks; i += 1) await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(trigger(page)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { checked: true }),
      ).toBeFocused();
      // Enter on the focused trigger opens the palette (a link, activated from the keyboard)
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeVisible();
      await expect(input(page)).toBeFocused();
    });

    test("toggles: the shortcut again closes it", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await page.keyboard.press("Control+k");
      await expect(dialog(page)).toBeHidden();
      await page.keyboard.press("Control+k");
      await expect(dialog(page)).toBeVisible();
    });

    test("Escape closes it and focus returns to the trigger it was opened from", async ({
      page,
    }) => {
      await visit(page, "/");
      await trigger(page).click();
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
      await expect(trigger(page)).toBeFocused();

      // also when the shortcut opened it while the trigger had focus
      await page.keyboard.press("Control+k");
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger(page)).toBeFocused();
    });

    test("Ctrl+K works while typing in another input, which keeps its text and focus", async ({
      page,
    }) => {
      await visit(page, "/search");
      const field = page.getByRole("searchbox", { name: "Search all documentation" });
      await field.fill("half typed");
      await openPalette(page);
      await expect(input(page)).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("half typed");
    });

    test("closes with the Close button and a click on the backdrop; the page cannot scroll while open", async ({
      page,
    }) => {
      await visit(page, "/");
      await openPalette(page);
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
      await page.getByTestId("palette-close").click();
      await expect(dialog(page)).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");

      await openPalette(page);
      await page.mouse.click(5, 5);
      await expect(dialog(page)).toBeHidden();
    });

    test("traps focus: Tab goes input, See all results, Close, and around", async ({ page }) => {
      // tall enough that the 8 rows fit and the list is not a scrolling box (a tab stop of its own)
      await page.setViewportSize({ width: 1280, height: 1100 });
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("palette-see-all")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("palette-close")).toBeFocused();
      // the focus wraps inside the dialog instead of leaving for the browser's own controls
      await page.keyboard.press("Tab");
      await expect(input(page)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("palette-close")).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("palette-see-all")).toBeFocused();
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
      }
    });

    test("a list that scrolls is a tab stop of its own, so it can be scrolled from the keyboard", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 600 });
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      const body = page.getByTestId("palette-body");
      await expect(body).toHaveAttribute("tabindex", "0");
      await page.keyboard.press("Tab");
      await expect(body).toBeFocused();
      await page.keyboard.press("PageDown");
      await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("palette-see-all")).toBeFocused();
      // a list that fits is not
      await input(page).fill("onboarding");
      await expect(options(page)).toHaveCount(1);
      await expect(body).not.toHaveAttribute("tabindex", /.*/);
    });

    test("the page behind is inert while it is open", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      expect(
        await page.evaluate(() => {
          const el = document.elementFromPoint(5, 5);
          return el?.closest("dialog") !== null;
        }),
      ).toBe(true);
    });
  });

  test.describe("live results", () => {
    test("typing shows the best matches, title match first, with highlights", async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      const first = options(page).first();
      await expect(first).toContainText("Deployment");
      await expect(first).toContainText("acme/search-lab / docs/deployment.md");
      await expect(first).toHaveAttribute("href", "/acme/search-lab/docs/deployment");
      expect((await optionTitles(page)).slice(0, 3)).toEqual([
        "Deployment",
        "Operations",
        "Release pipeline",
      ]);
      // the heading match deep-links to its section
      await expect(options(page).nth(1)).toHaveAttribute(
        "href",
        /^\/acme\/search-lab\/docs\/guides\/operations#.+/,
      );
      const marks = page.getByRole("option").locator("mark");
      expect(await marks.count()).toBeGreaterThanOrEqual(3);
      for (const text of await marks.allTextContents())
        expect(text.toLowerCase()).toBe("deployment");
      await expect(status(page)).toHaveText("8 of 10 results");
      await expect(input(page)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("palette-see-all")).toHaveText(
        'See all results for "deployment"',
      );
      expect(errors).toEqual([]);
    });

    test("debounces: fast typing sends one request, for the final text", async ({ page }) => {
      await visit(page, "/");
      const requests: string[] = [];
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/api/search") requests.push(r.url());
      });
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.waitForTimeout(300);
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0] ?? "").searchParams.get("q")).toBe("deployment");
      expect(new URL(requests[0] ?? "").searchParams.get("limit")).toBe("8");
    });

    test("does not show the answer to an older query when it arrives late", async ({ page }) => {
      await page.route(/\/api\/search\?q=slow/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              q: "slow",
              total: 1,
              seeAll: "/search?q=slow",
              hits: [
                {
                  key: "9:docs/stale.md",
                  title: "STALE ANSWER",
                  href: "/acme/api-service",
                  repoLabel: "acme/api-service",
                  path: "docs/stale.md",
                  section: null,
                  snippet: "",
                  isPrivate: false,
                },
              ],
            }),
          })
          .catch(() => undefined);
      });
      await visit(page, "/");
      await openPalette(page);
      await input(page).fill("slow");
      await page.waitForTimeout(250);
      await input(page).fill("deployment");
      await expect(options(page)).toHaveCount(8);
      await page.waitForTimeout(900);
      await expect(page.getByText("STALE ANSWER")).toHaveCount(0);
      await expect(options(page)).toHaveCount(8);
    });

    test("shows a no-results message that echoes the query as text", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "zzzznothing");
      await expect(page.getByTestId("palette-empty")).toHaveText("No results for “zzzznothing”.");
      await expect(status(page)).toHaveText("No results");
      await expect(options(page)).toHaveCount(0);
      await expect(input(page)).toHaveAttribute("aria-expanded", "false");
    });

    test("special characters are plain text: no error, results or an empty state", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      const answers: number[] = [];
      page.on("response", (r) => {
        if (new URL(r.url()).pathname === "/api/search") answers.push(r.status());
      });
      await visit(page, "/");
      await openPalette(page);
      for (const text of [
        '"unclosed & | ! ( ',
        ")(",
        "-",
        "OR",
        "<script>alert(1)</script>",
        "%",
        "a'; drop table documents; --",
        "\\",
        "*:*",
      ]) {
        await input(page).fill(text);
        // wait for the answer to this text (the status is empty while it is pending)
        await expect(status(page)).not.toHaveText("");
        await expect(page.getByTestId("palette-error")).toHaveCount(0);
      }
      await input(page).fill("deployment");
      await expect(options(page)).toHaveCount(8);
      expect(answers.length).toBeGreaterThan(3);
      expect(new Set(answers)).toEqual(new Set([200]));
      expect(await page.evaluate(() => "__xss" in window)).toBe(false);
      expect(errors).toEqual([]);
    });

    test("a very long query is cut by the input and does not break the dialog", async ({
      page,
    }) => {
      await visit(page, "/");
      await openPalette(page);
      await input(page).fill("a".repeat(2000));
      expect(await input(page).inputValue()).toHaveLength(256);
      await expect(page.getByTestId("palette-empty")).toBeVisible();
      const box = await dialog(page).boundingBox();
      const link = await page.getByTestId("palette-see-all").boundingBox();
      expect(link!.width).toBeLessThanOrEqual(box!.width);
    });

    test("marks a private repository's result with a badge", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "onboarding", 1);
      const row = options(page).first();
      await expect(row).toContainText("Onboarding");
      await expect(row).toContainText("acme/internal-tools");
      await expect(row.getByTestId("palette-private-badge")).toHaveText("Private");
      // public results carry none
      await input(page).fill("deployment");
      await expect(options(page)).toHaveCount(8);
      await expect(options(page).first().getByTestId("palette-private-badge")).toHaveCount(0);
    });

    test("shows a hostile document title as text and runs nothing", async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await visit(page, "/");
      await openPalette(page);
      await search(page, "gateway", 1);
      const row = options(page).first();
      await expect(row).toContainText("<script>window.__xss = 1</script>");
      expect(await row.locator("script").count()).toBe(0);
      expect(await page.evaluate(() => "__xss" in window)).toBe(false);
      expect(errors).toEqual([]);
    });

    test("shows a non-blocking error when search is unavailable, and recovers", async ({
      page,
    }) => {
      let fail = true;
      await page.route(/\/api\/search\?/, (route) =>
        fail
          ? route.fulfill({
              status: 503,
              contentType: "application/json",
              body: '{"error":"unavailable"}',
            })
          : route.continue(),
      );
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment");
      await expect(page.getByTestId("palette-error")).toContainText("Search is unavailable");
      await expect(status(page)).toHaveText("Search is unavailable");
      await expect(page.getByTestId("palette-see-all")).toHaveAttribute(
        "href",
        "/search?q=deployment",
      );
      fail = false;
      await input(page).pressSequentially(" now");
      await input(page).fill("deployment");
      await expect(options(page)).toHaveCount(8);
      await expect(page.getByTestId("palette-error")).toHaveCount(0);
    });
  });

  test.describe("keyboard and mouse navigation", () => {
    test("ArrowDown and ArrowUp move the active option, wrapping; focus stays in the input", async ({
      page,
    }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      const active = () => page.locator('[role=option][aria-selected="true"]');
      await expect(active()).toHaveCount(0);
      await expect(input(page)).not.toHaveAttribute("aria-activedescendant", /.+/);

      await page.keyboard.press("ArrowDown");
      await expect(active()).toHaveCount(1);
      await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
      const firstId = await options(page).nth(0).getAttribute("id");
      await expect(input(page)).toHaveAttribute("aria-activedescendant", firstId ?? "");

      await page.keyboard.press("ArrowDown");
      await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "false");
      await page.keyboard.press("ArrowUp");
      await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowUp");
      await expect(options(page).nth(7)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowDown");
      await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("End");
      await expect(options(page).nth(7)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Home");
      await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
      await expect(input(page)).toBeFocused();
    });

    test("the active option is visibly different and scrolls into view", async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 420 });
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
      const last = options(page).nth(7);
      await expect(last).toHaveAttribute("aria-selected", "true");
      await expect(last).toBeInViewport();
      const body = page.getByTestId("palette-body");
      const [lastBox, bodyBox] = [await last.boundingBox(), await body.boundingBox()];
      expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height + 1);
    });

    test("hovering moves the active option without taking focus from the input", async ({
      page,
    }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await options(page).nth(2).hover();
      await expect(options(page).nth(2)).toHaveAttribute("aria-selected", "true");
      await expect(input(page)).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(options(page).nth(3)).toHaveAttribute("aria-selected", "true");
    });

    test("Enter opens the active result's document page", async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/deployment$/);
      await expect(page.getByRole("heading", { level: 1, name: "Deployment" })).toBeVisible();
      await expect(dialog(page)).toBeHidden();
      expect(errors).toEqual([]);
    });

    test("Enter on a heading match lands on the section", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/guides\/operations#.+/);
      await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
    });

    test("opens a result from any page, including the one it is on", async ({ page }) => {
      await visit(page, "/acme/search-lab/docs/deployment");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeHidden();
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/deployment$/);
    });

    test("Enter with no active option opens the full results page", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(page.getByTestId("result")).toHaveCount(10);
      await expect(dialog(page)).toBeHidden();
    });

    test("'See all results' goes to /search?q=...", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.getByTestId("palette-see-all").click();
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();
      await expect(dialog(page)).toBeHidden();
    });

    test("clicking a result navigates in the app", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await options(page).nth(1).click();
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/guides\/operations#.+/);
      await expect(dialog(page)).toBeHidden();
    });

    test("Ctrl/Cmd+Enter and Ctrl/Cmd+click open the result in a new tab", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      await page.keyboard.press("ArrowDown");
      const popup = page.waitForEvent("popup");
      await page.keyboard.press("ControlOrMeta+Enter");
      const tab = await popup;
      // A new tab starts at about:blank, so wait for the navigation itself, not for "load".
      await tab.waitForURL((url) => url.pathname === "/acme/search-lab/docs/deployment");
      expect(new URL(tab.url()).pathname).toBe("/acme/search-lab/docs/deployment");
      await tab.close();
      // the palette stays open on the original page
      await expect(dialog(page)).toBeVisible();

      const popup2 = page.context().waitForEvent("page");
      await options(page)
        .nth(1)
        .click({ modifiers: ["ControlOrMeta"] });
      const tab2 = await popup2;
      // A new tab starts at about:blank, so wait for the navigation itself, not for "load".
      await tab2.waitForURL((url) => url.pathname === "/acme/search-lab/docs/guides/operations");
      expect(new URL(tab2.url()).pathname).toBe("/acme/search-lab/docs/guides/operations");
      await expect(dialog(page)).toBeVisible();
    });

    test("middle click opens a result in a new tab", async ({ page }) => {
      await visit(page, "/");
      await openPalette(page);
      await search(page, "deployment", 8);
      const popup = page.context().waitForEvent("page");
      await options(page).nth(0).click({ button: "middle" });
      const tab = await popup;
      // A new tab starts at about:blank, so wait for the navigation itself, not for "load".
      await tab.waitForURL((url) => url.pathname === "/acme/search-lab/docs/deployment");
      expect(new URL(tab.url()).pathname).toBe("/acme/search-lab/docs/deployment");
    });
  });

  test.describe("the API route", () => {
    test("answers JSON that is never cached, and only to GET", async ({ request }) => {
      const res = await request.get("/api/search?q=deployment&limit=3");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("application/json; charset=utf-8");
      expect(res.headers()["cache-control"]).toBe("no-store");
      const body = await res.json();
      expect(body).toMatchObject({ q: "deployment", total: 10, seeAll: "/search?q=deployment" });
      expect(body.hits).toHaveLength(3);
      for (const verb of ["post", "put", "patch", "delete"] as const) {
        const refused = await request[verb]("/api/search?q=deployment");
        expect(refused.status(), verb).toBe(405);
        expect(refused.headers().allow).toBe("GET");
      }
      expect((await request.head("/api/search?q=deployment")).status()).toBe(405);
    });

    test("an empty or hostile query is a normal answer", async ({ request }) => {
      expect(await (await request.get("/api/search")).json()).toEqual({
        q: "",
        total: 0,
        hits: [],
        seeAll: "/search",
      });
      for (const q of ['"unclosed & | ! ( ', "%", "\\", "a".repeat(3000)]) {
        const res = await request.get(`/api/search?q=${encodeURIComponent(q)}&limit=-1&repo=%00`);
        expect(res.status(), q.slice(0, 10)).toBe(200);
      }
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("an icon button opens a full-screen sheet; a tap on a result navigates", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      await visit(page, "/");
      const button = trigger(page);
      await expect(button).toBeVisible();
      // icon only: the word is for screen readers, the shortcut chip is hidden
      await expect(page.getByTestId("palette-shortcut")).toBeHidden();
      expect((await button.boundingBox())!.width).toBeLessThan(60);
      await expect(page.locator("header").getByTestId("palette-trigger")).toHaveCount(1);
      await button.tap();
      await expect(dialog(page)).toBeVisible();
      await expect(input(page)).toBeFocused();
      const box = await page.locator("dialog > div").boundingBox();
      expect(Math.round(box!.width)).toBe(390);
      expect(Math.round(box!.height)).toBe(844);
      await search(page, "deployment", 8);
      await expect(page.getByTestId("palette-close")).toBeVisible();
      await options(page).first().tap();
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/deployment$/);
      await expect(page.getByRole("heading", { level: 1, name: "Deployment" })).toBeVisible();
      await expect(dialog(page)).toBeHidden();
      expect(errors).toEqual([]);
    });

    test("the Close button works on a phone", async ({ page }) => {
      await visit(page, "/");
      await trigger(page).tap();
      await expect(dialog(page)).toBeVisible();
      await page.getByTestId("palette-close").tap();
      await expect(dialog(page)).toBeHidden();
      await expect(trigger(page)).toBeFocused();
    });
  });

  test.describe("themes", () => {
    for (const theme of ["light", "dark"] as const) {
      test(`${theme}: the palette uses the theme tokens`, async ({ page }, testInfo) => {
        await setTheme(page, theme);
        const errors = collectBrowserErrors(page);
        await visit(page, "/");
        await openPalette(page);
        await search(page, "deployment", 8);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");

        const tokens = THEME_TOKENS[theme];
        const rgb = (hex: string) => {
          const n = parseInt(hex.slice(1), 16);
          return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
        };
        const style = (locator: Locator, property: string) =>
          locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
        const panel = page.locator("dialog > div");
        expect(await style(panel, "background-color")).toBe(rgb(tokens.popover));
        expect(await style(options(page).nth(1), "background-color")).toBe(rgb(tokens.muted));
        expect(await style(options(page).nth(0), "background-color")).toBe("rgba(0, 0, 0, 0)");
        expect(await style(page.getByTestId("palette-see-all"), "color")).toBe(rgb(tokens.link));
        expect(await style(options(page).nth(0).locator("mark").first(), "background-color")).toBe(
          rgb(tokens.accent),
        );

        await page.screenshot({
          path: testInfo.outputPath(`palette-${theme}-results.png`),
        });
        await input(page).fill("zzzznothing");
        await expect(page.getByTestId("palette-empty")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`palette-${theme}-empty.png`) });
        await input(page).fill("");
        await expect(page.getByTestId("palette-hint")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`palette-${theme}-hint.png`) });
        expect(errors).toEqual([]);
      });

      test(`${theme}: phone screenshot`, async ({ page }, testInfo) => {
        await setTheme(page, theme);
        await page.setViewportSize({ width: 390, height: 844 });
        await visit(page, "/");
        await page.screenshot({
          path: testInfo.outputPath(`palette-${theme}-phone-header.png`),
        });
        await trigger(page).click();
        await search(page, "deployment", 8);
        await page.keyboard.press("ArrowDown");
        await page.screenshot({ path: testInfo.outputPath(`palette-${theme}-phone.png`) });
      });

      test(`${theme}: header trigger on desktop`, async ({ page }, testInfo) => {
        await setTheme(page, theme);
        await visit(page, "/");
        await expect(trigger(page)).toBeVisible();
        await page
          .locator("header")
          .screenshot({ path: testInfo.outputPath(`palette-${theme}-header.png`) });
        const tokens = THEME_TOKENS[theme];
        const color = await trigger(page).evaluate((el) => getComputedStyle(el).color);
        const n = parseInt(tokens["header-foreground"].slice(1), 16);
        expect(color).toBe(`rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`);
      });
    }
  });
});

test.describe("command palette, database unreachable", () => {
  test.use({ baseURL: stackUrl("unreachable") });

  test("shows 'Search is unavailable' without leaking details, and stays usable", async ({
    page,
  }) => {
    await visit(page, "/");
    await openPalette(page);
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/search");
    await search(page, "deployment");
    const response = await answered;
    expect(response.status()).toBe(503);
    // the body is fixed text: no query, no error message, no connection detail
    expect(await page.evaluate(() => fetch("/api/search?q=deployment").then((r) => r.text()))).toBe(
      '{"error":"unavailable"}',
    );
    await expect(page.getByTestId("palette-error")).toContainText("Search is unavailable");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=deployment$/);
  });
});
