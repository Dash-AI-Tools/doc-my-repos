import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Plugin pages (plugin-api): `/-/<plugin>/<path>` renders a plugin's page inside the site layout.
 * The fixture server registers the e2e fixture plugin (`packages/ui/src/pages/e2e-plugin.tsx`).
 * `x-e2e-user` naming a user the (unreachable) database cannot confirm makes the request signed
 * out under the e2e auth bypass.
 */

const KEY = "docmyrepos-theme";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

for (const theme of ["light", "dark"] as const) {
  test(`a plugin page renders inside the layout, ${theme} theme, with no axe violations`, async ({
    page,
  }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [KEY, theme]);
    const response = await page.goto("/-/fixture/hello");
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveClass(
      theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
    );
    await expect(page).toHaveTitle("Fixture plugin · DocMyRepos");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Hello from a plugin");
    await expect(main.getByTestId("fixture-tenant")).toHaveText("Rendered for tenant default.");
    await expect(page.locator("header").first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
}

test.describe("signed out", () => {
  test.use({ extraHTTPHeaders: { "x-e2e-user": "nobody@example.com" } });

  test("a public plugin page renders", async ({ page }) => {
    const response = await page.goto("/-/fixture/public/hi");
    expect(response?.status()).toBe(200);
    await expect(page.locator("main").getByRole("heading", { level: 1 })).toHaveText(
      "Hi, signed out or not",
    );
  });

  test("a plugin page that is not public sends to the sign-in page", async ({ page }) => {
    await page.goto("/-/fixture/hello");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test("an unknown plugin or page is not found", async ({ page }) => {
  for (const path of ["/-/nope/hello", "/-/fixture/missing", "/-/fixture/public/undeclared"]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
});

test.describe("repository pages", () => {
  test.use({ baseURL: stackUrl("seeded") });

  test("are unaffected by the plugin segment", async ({ page }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    const response = await page.goto("/acme/api-service");
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("repo-header").getByRole("heading", { level: 1 })).toHaveText(
      "acme/api-service",
    );
  });
});
