import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { E2E_CRASH_HEADER } from "../src/lib/e2e-fixtures";
import { THEME_TOKENS, type ThemeName } from "../src/lib/theme-tokens";
import { expect, test } from "./support/csp";
import { stackUrl } from "./support/stack";

/**
 * `src/app/global-error.tsx` in a real browser. The root layout is made to throw by sending the
 * `x-e2e-crash-layout` header, which the layout honors only on the fixtures server
 * (`E2E_FIXTURES=1`, no database). With the layout gone there is no stylesheet, no theme provider
 * and no header: the page must still read well in both color schemes (it follows
 * `prefers-color-scheme`), pass axe, offer a retry and a way home, and show no error details.
 */

test.use({ baseURL: stackUrl("fixtures") });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Adds the crash header to document requests until `state.crash` is turned off. */
async function crashLayout(page: Page): Promise<{ crash: boolean }> {
  const state = { crash: true };
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (state.crash && (request.resourceType() === "document" || request.headers().rsc === "1")) {
      await route.continue({ headers: { ...request.headers(), [E2E_CRASH_HEADER]: "1" } });
    } else {
      await route.continue();
    }
  });
  return state;
}

function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

for (const theme of ["light", "dark"] as const satisfies readonly ThemeName[]) {
  test.describe(`${theme} scheme`, () => {
    test.use({ colorScheme: theme });
    const tokens = THEME_TOKENS[theme];

    test("replaces a crashed root layout with a styled, accessible error page", async ({
      page,
    }) => {
      await crashLayout(page);
      const response = await page.goto("/");
      expect(response?.status()).toBe(500);

      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page).toHaveTitle(/Something went wrong/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Something went wrong" }),
      ).toBeVisible();
      // the app's header, footer and theme toggle are gone with the layout
      await expect(page.getByTestId("theme-toggle")).toHaveCount(0);
      await expect(page.getByRole("banner")).toHaveCount(0);

      // colors come from the tokens of the OS scheme
      const colors = await page.evaluate(() => {
        const panel = document.querySelector("[data-testid=global-error]");
        const primary = document.querySelector("button");
        return {
          body: getComputedStyle(document.body).backgroundColor,
          text: getComputedStyle(document.body).color,
          panel: panel === null ? "" : getComputedStyle(panel).backgroundColor,
          button: primary === null ? "" : getComputedStyle(primary).backgroundColor,
        };
      });
      expect(colors).toEqual({
        body: rgb(tokens.background),
        text: rgb(tokens.foreground),
        panel: rgb(tokens["destructive-muted"]),
        button: rgb(tokens.primary),
      });

      // no error details: the stack, message and server paths are not on the page
      const text = (await page.locator("body").innerText()).toLowerCase();
      expect(text).not.toMatch(/forced root layout crash|e2e:|\.tsx|at \w+ \(/);

      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(
        results.violations.map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" ; ")}`,
        ),
      ).toEqual([]);

      await page.screenshot({ path: `test-results/global-error-${theme}.png` });
    });
  });
}

test("the home link leaves the error page with a full page load", async ({ page }) => {
  const state = await crashLayout(page);
  await page.goto("/");
  await expect(page.getByTestId("global-error")).toBeVisible();
  state.crash = false;
  await page.getByRole("link", { name: "Back to the home page" }).click();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByTestId("global-error")).toHaveCount(0);
});

test("the retry button fetches the page again, and recovers once the layout works again", async ({
  page,
}) => {
  const state = await crashLayout(page);
  await page.goto("/");
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();

  // still crashing: the boundary stays
  await retry.click();
  await expect(page.getByTestId("global-error")).toBeVisible();

  // the layout works again: retry shows the real page
  state.crash = false;
  await retry.click();
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("global-error")).toHaveCount(0);
});

test("the crash header does nothing on a server without the fixtures switch", async ({
  browser,
}) => {
  // The unreachable-database server runs without E2E_FIXTURES (see serverEnv in e2e/support/stack.ts).
  const unreachable = stackUrl("unreachable");
  const context = await browser.newContext({
    extraHTTPHeaders: { [E2E_CRASH_HEADER]: "1" },
  });
  try {
    const response = await context.request.get(`${unreachable}/search`);
    expect(response.status()).toBeLessThan(500);
    expect(await response.text()).not.toContain("global-error");
  } finally {
    await context.close();
  }
});
