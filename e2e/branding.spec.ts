import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Org branding end to end (task 5.1): branding set through the admin API shows in the bar,
 * titles, computed styles and the logo route, in both themes. Runs against the `empty` stack,
 * whose database no other spec asserts titles on, and resets branding afterwards.
 *
 * A viewer getting 403 on the branding APIs is covered by
 * `packages/server/src/admin/branding-service.test.ts` (the e2e servers run with E2E_AUTH_BYPASS, so
 * every request there is an admin). The signed-out sign-in page shares the root layout, so the
 * logo-in-header case is covered by `src/app/layout.test.tsx` with a null user.
 */

const BASE = stackUrl("empty");
const KEY = "docmyrepos-theme";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const SCRIPT_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;

const BRANDING = {
  orgName: "Acme",
  pageTitle: "Acme Docs",
  primaryColor: "#2b59ff",
  accentColor: "#9333ea",
  coloredHeader: true,
  invertLogoOnDark: true,
};

// Serial: every test shares the one `empty` database, and branding state carries between them.
test.describe.configure({ mode: "serial" });

async function setBranding(
  request: APIRequestContext,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await request.put(`${BASE}/api/admin/branding`, { data: patch });
  expect(response.status(), await response.text()).toBe(200);
}

async function uploadLogo(request: APIRequestContext, bytes: Buffer): Promise<void> {
  const response = await request.put(`${BASE}/api/admin/branding/logo`, { data: bytes });
  expect(response.status(), await response.text()).toBe(200);
}

async function resetBranding(request: APIRequestContext): Promise<void> {
  const response = await request.delete(`${BASE}/api/admin/branding`);
  expect(response.status(), await response.text()).toBe(200);
}

async function open(page: Page, theme: "light" | "dark", path = "/"): Promise<void> {
  await page.addInitScript(([key, value]: [string, string]) => localStorage.setItem(key, value), [
    KEY,
    theme,
  ] as [string, string]);
  await page.goto(`${BASE}${path}`);
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

test.beforeAll(async ({ request }) => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  await setBranding(request, BRANDING);
  await uploadLogo(request, PNG);
});

test.afterAll(async ({ request }) => {
  if (SKIP_DB) return;
  await resetBranding(request);
});

test.describe("branded portal", () => {
  test("shows the logo and page title in the bar, and brands tab and page titles", async ({
    page,
  }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await open(page, "light");
    const bar = page.locator("header").first();
    await expect(bar.getByRole("link", { name: "Acme Docs", exact: true })).toBeVisible();
    // The logo stands in for the organization name, so it is not repeated beside it.
    await expect(bar.getByRole("link", { name: "Acme", exact: true })).toHaveCount(0);
    await expect(page).toHaveTitle("Acme Docs");
    await page.goto(`${BASE}/search`);
    await expect(page).toHaveTitle("Search \u00b7 Acme Docs");
  });

  test("applies the primary and accent to computed styles", async ({ page }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await open(page, "light");
    expect(await cssVar(page, "--primary")).toBe("#2b59ff");
    expect(await cssVar(page, "--accent")).not.toBe("");
  });

  test("uses a dark shade of the primary for the dark page and its surfaces", async ({
    page,
    request,
  }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await open(page, "dark");
    // #2b59ff lowered to the dark ramp's lightness: a deep blue, not the neutral near-black.
    expect(await cssVar(page, "--background")).toBe("#001252");
    expect(await cssVar(page, "--card")).toBe("#001252");
    expect(await cssVar(page, "--muted")).toBe("#00176b");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(0, 18, 82)",
    );
    // With no colored bar the bar follows the tinted page instead of staying near-black.
    await setBranding(request, { coloredHeader: false });
    await open(page, "dark");
    expect(await cssVar(page, "--header")).toBe("#001252");
    await setBranding(request, { coloredHeader: true });
  });

  test("inverts the logo in the dark theme only when the switch is on", async ({
    page,
    request,
  }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await open(page, "dark");
    const logo = page.locator("header").first().locator("img").first();
    await expect(logo).toHaveAttribute("src", /\/api\/branding\/logo\?v=\d+/);
    expect(await logo.evaluate((el) => getComputedStyle(el).filter)).toBe("invert(1)");
    await open(page, "light");
    // #2b59ff bar: white text, so the light bar inverts too.
    expect(await logo.evaluate((el) => getComputedStyle(el).filter)).toBe("invert(1)");
    await setBranding(request, { invertLogoOnDark: false });
    await open(page, "dark");
    expect(await logo.evaluate((el) => getComputedStyle(el).filter)).toBe("none");
    await setBranding(request, { invertLogoOnDark: true });
  });

  test("serves the original logo bytes from the logo address", async ({ page, request }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await open(page, "light");
    const src = await page.locator("header").first().locator("img").first().getAttribute("src");
    const response = await request.get(`${BASE}${src}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await response.body())).toEqual(PNG);
  });

  test("fills the colored bar with the primary in both themes", async ({ page }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await open(page, "light");
    const lightBar = await page
      .locator("header")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(lightBar).toBe("rgb(43, 89, 255)");
    await open(page, "dark");
    const darkBar = await page
      .locator("header")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(darkBar).not.toBe(pageBg);
  });

  test("keeps the footer credit and star links with no external request", async ({ page }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    const external: string[] = [];
    page.on("request", (req) => {
      if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(req.url())) external.push(req.url());
    });
    await open(page, "light");
    const credit = page.getByTestId("footer-credit-link");
    await expect(credit).toHaveAccessibleName("DocMyRepos");
    await expect(credit).toHaveAttribute("href", "https://github.com/Dash-AI-Tools/doc-my-repos");
    await expect(credit).toHaveAttribute("target", "_blank");
    const star = page.getByTestId("footer-star-link");
    await expect(star).toHaveAttribute("href", "https://github.com/Dash-AI-Tools/doc-my-repos");
    await expect(star).toHaveAttribute("target", "_blank");
    await page.waitForTimeout(500);
    expect(external).toEqual([]);
  });

  test("runs no script from a script-bearing SVG logo", async ({ page, request, browser }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await uploadLogo(request, Buffer.from(SCRIPT_SVG, "utf8"));
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await open(page, "light");
    await expect(page.locator("header").first().locator("img").first()).toBeVisible();
    // Opened directly, the SVG is a document in our origin: use an unwatched context, since
    // the sandbox CSP correctly reports the blocked inline script as a violation there.
    const context = await browser.newContext();
    const direct = await context.newPage();
    direct.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await direct.goto(`${BASE}/api/branding/logo?v=9999`);
    await direct.waitForTimeout(500);
    await context.close();
    expect(dialogs).toEqual([]);
    await uploadLogo(request, PNG);
  });

  test("fits a wide logo and long title at phone width", async ({ page, request }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await setBranding(request, { pageTitle: "A very long page title that keeps going" });
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, "light");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await setBranding(request, { pageTitle: BRANDING.pageTitle });
  });

  for (const theme of ["light", "dark"] as const) {
    for (const colored of [true, false]) {
      test(`axe, ${theme}, colored bar ${colored ? "on" : "off"}: no violations`, async ({
        page,
        request,
      }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await setBranding(request, { coloredHeader: colored });
        await open(page, theme);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(
          results.violations.map(
            (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" ; ")}`,
          ),
        ).toEqual([]);
      });
    }
  }

  test("reset restores the defaults", async ({ page, request }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    await resetBranding(request);
    await open(page, "light");
    await expect(page).toHaveTitle("DocMyRepos");
    await expect(page.locator("header").first().getByText("DocMyRepos")).toBeVisible();
    await expect(page.getByTestId("footer-credit-link")).toBeVisible();
    await setBranding(request, BRANDING);
    await uploadLogo(request, PNG);
  });
});
