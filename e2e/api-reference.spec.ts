import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect, test, watchCsp } from "./support/csp";
import { openSession } from "./support/comments";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * The API reference under the real CSP (openapi-reference tasks 5.5 and 6.1): repository page
 * list, tags and operations, deep link, read-only, address parameters ignored, a hostile spec,
 * no network request and no CSP violation (the `test` from ./support/csp fails on any), a blocked
 * repository, a repository without specs, and axe, phone width and targets in both themes.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);

const BASE = stackUrl("seeded");
const { owner, name } = SEEDED.apiReference;
const REPO = `/${owner}/${name}`;
const MAIN = `${REPO}/api-reference/openapi.yaml`;
const LEGACY = `${REPO}/api-reference/docs/api/swagger.yaml`;
const HOSTILE = `${REPO}/api-reference/docs/hostile/openapi.yaml`;
const THEMES = ["light", "dark"] as const;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
/**
 * Rules about the widget's own markup, which a stylesheet cannot change (nested `main`, heading
 * levels, unnamed selects, a button that wraps a link). Everything else, contrast and target size
 * included, is checked inside the widget too.
 */
const WIDGET_STRUCTURE_RULES = new Set([
  "heading-order",
  "landmark-main-is-top-level",
  "landmark-no-duplicate-main",
  "landmark-unique",
  "nested-interactive",
  "select-name",
]);

async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("docmyrepos-theme", value), theme);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${BASE}${path}`);
  await expect(page.locator(".api-reference .swagger-ui .opblock").first()).toBeVisible();
}

async function expandAll(page: Page): Promise<void> {
  const controls = page.locator(
    ".api-reference .opblock:not(:has(.opblock-body)) .opblock-summary-control",
  );
  while ((await controls.count()) > 0) await controls.first().click();
}

/** Records every request the page makes outside the app's own origin. */
function trackForeignRequests(page: Page): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(BASE)) foreign.push(request.url());
  });
  return foreign;
}

async function expectAxeClean(page: Page, label: string): Promise<void> {
  // Everything, the widget included, except the structure rules above.
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .disableRules([...WIDGET_STRUCTURE_RULES])
    .analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    [],
  );
  // The structure rules still cover the site's own markup around the widget.
  const shell = await new AxeBuilder({ page }).withTags(TAGS).exclude(".api-reference").analyze();
  const own = shell.violations.filter((v) => !v.id.startsWith("landmark-"));
  expect(own, `${label} (site markup): ${JSON.stringify(own, null, 2)}`).toEqual([]);
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scroll.scrollWidth, `${label}: horizontal page scroll`).toBeLessThanOrEqual(
    scroll.innerWidth,
  );
  const wide = await page.locator(".api-reference").evaluate((root) =>
    Array.from(root.querySelectorAll("*"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // Code blocks and tables scroll inside their own box: only the box itself must fit.
        return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
      })
      .filter((el) => !el.closest("pre, table, .model-box, .opblock-body"))
      .slice(0, 5)
      .map((el) => el.tagName.toLowerCase() + "." + String((el as HTMLElement).className)),
  );
  expect(wide, `${label}: elements outside the viewport`).toEqual([]);
}

test("the repository page lists the specs, a repository without specs has no section", async ({
  page,
}) => {
  await page.goto(`${BASE}${REPO}`);
  const items = page.getByTestId("api-spec");
  await expect(page.getByTestId("api-specs")).toBeVisible();
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: "Orders API" })).toContainText("v2.4.1");
  await expect(items.filter({ hasText: "Orders API" })).toContainText("OpenAPI 3.0");
  await expect(items.filter({ hasText: "Legacy API" })).toContainText("Swagger 2.0");
  await items.filter({ hasText: "Orders API" }).getByRole("link").click();
  await expect(page).toHaveURL(`${BASE}${MAIN}`);

  await page.goto(`${BASE}/${SEEDED.full.owner}/${SEEDED.full.name}`);
  await expect(page.getByTestId("repo-header")).toBeVisible();
  await expect(page.getByTestId("api-specs")).toHaveCount(0);
});

test("the reference shows the header, tags and operations, read-only and offline", async ({
  page,
}) => {
  const foreign = trackForeignRequests(page);
  await open(page, MAIN);
  await expect(page.getByTestId("api-reference-header")).toContainText("Orders API");
  await expect(page.getByTestId("source-link")).toHaveAttribute(
    "href",
    `https://github.com/${owner}/${name}/blob/main/openapi.yaml`,
  );
  const widget = page.locator(".api-reference");
  await expect(widget.locator(".opblock-tag", { hasText: "orders" })).toBeVisible();
  await expect(widget.locator(".opblock-tag", { hasText: "customers" })).toBeVisible();
  await expect(widget.locator(".opblock")).toHaveCount(3);
  // The method is text, not only color.
  await expect(widget.locator(".opblock-summary-method")).toHaveText(["GET", "POST", "DELETE"]);
  await expect(widget.locator(".opblock-deprecated .opblock-summary-method")).toHaveText("DELETE");
  await expect(widget.locator(".opblock-summary-path").first()).toHaveText("/orders");

  await expandAll(page);
  await expect(widget.locator(".opblock-deprecated")).toContainText("Deprecated");
  await expect(widget.getByText("Request body").first()).toBeVisible();
  // Read-only: nothing sends a request.
  await expect(widget.locator(".try-out, .try-out__btn, .execute")).toHaveCount(0);
  await expect(widget.getByRole("button", { name: /try it out|execute/i })).toHaveCount(0);
  await expect(page.locator("section.models")).toBeVisible();
  expect(foreign, "requests outside the app").toEqual([]);
});

test("Swagger 2.0 is displayed", async ({ page }) => {
  await open(page, LEGACY);
  await expect(page.locator(".api-reference .opblock-summary-method")).toHaveText("GET");
  await expect(page.locator(".api-reference .opblock-summary-path")).toHaveText("/users");
});

test("an operation anchor opens that operation", async ({ page }) => {
  await page.goto(`${BASE}${MAIN}#/customers/deleteAdjustment`);
  const op = page.locator("#operations-customers-deleteAdjustment");
  await expect(op).toBeVisible();
  await expect(op.locator(".opblock-body")).toBeVisible();
  await expect(op).toBeInViewport();
});

test("?url= and ?configUrl= are ignored and make no request", async ({ page }) => {
  const foreign = trackForeignRequests(page);
  const requested: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() !== "document") requested.push(r.url());
  });
  await open(
    page,
    `${MAIN}?url=https://evil.example/other.json&configUrl=https://evil.example/config.json`,
  );
  await expect(page.locator(".api-reference .info .title")).toContainText("Orders API");
  await expect(page.locator(".api-reference .opblock")).toHaveCount(3);
  expect(foreign).toEqual([]);
  expect(requested.filter((u) => u.includes("evil.example"))).toEqual([]);
});

test("a hostile spec executes nothing and loads nothing but an allowed image", async ({
  browser,
}) => {
  // The spec's inline event handlers are refused by the CSP (`script-src-attr`): that report is
  // expected here, so this context is watched by hand instead of failing on any violation.
  const context = await browser.newContext();
  const watch = await watchCsp(context);
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  const foreign = trackForeignRequests(page);
  await page.route("https://evil.example/**", (route) => route.abort());
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__pwned = 0;
    const w = window as unknown as Record<string, unknown>;
    const trap = () => {
      w.__pwned = (w.__pwned as number) + 1;
    };
    w.alert = trap;
    w.confirm = trap;
    w.prompt = trap;
  });
  await open(page, HOSTILE);
  await expandAll(page);
  await page.waitForTimeout(500);

  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Record<string, number>).__pwned)).toBe(0);
  const root = page.locator(".api-reference");
  expect(await root.locator("script").count()).toBe(0);
  expect(await root.locator("iframe, object, embed").count()).toBe(0);
  expect(await root.locator("[onerror], [onload], [onclick]").count()).toBe(0);
  expect(await root.locator("a[href^='javascript:' i]").count()).toBe(0);
  // The only foreign requests allowed are https images (the site's image policy), never a spec.
  expect(foreign.filter((u) => !u.endsWith(".png"))).toEqual([]);
  // Whatever the CSP refused was an inline handler; no script, eval or other source was blocked.
  expect(watch.violations.filter((v) => v.directive !== "script-src-attr")).toEqual([]);
  await context.close();
});

test("a blocked repository answers 404 and its pages return when it is allowed again", async ({
  browser,
}) => {
  const admin = await openSession(browser, { stack: "starred" });
  const slug = `${owner}/${name}`;
  const base = stackUrl("starred");
  try {
    const before = await admin.page.goto(`${base}${MAIN}`);
    expect(before?.status()).toBe(200);
    await admin.page.goto(`${base}/admin/repos`);
    await admin.page.getByRole("button", { name: `Block ${slug}` }).click();
    await expect(admin.page.getByText(`${slug} is blocked.`)).toBeVisible();
    expect((await admin.page.goto(`${base}${MAIN}`))?.status()).toBe(404);
    expect((await admin.page.goto(`${base}${REPO}`))?.status()).toBe(404);
  } finally {
    await admin.page.goto(`${base}/admin/repos`);
    const allow = admin.page.getByRole("button", { name: `Allow ${slug}` });
    if (await allow.isVisible()) await allow.click();
    await expect(admin.page.getByRole("button", { name: `Block ${slug}` })).toBeVisible();
  }
  expect((await admin.page.goto(`${base}${MAIN}`))?.status()).toBe(200);
  await admin.close();
});

test("an unknown spec path answers 404", async ({ page }) => {
  expect((await page.goto(`${BASE}${REPO}/api-reference/nope.yaml`))?.status()).toBe(404);
});

for (const theme of THEMES) {
  test(`axe pass and layout, ${theme} theme, desktop`, async ({ page }) => {
    await useTheme(page, theme);
    await open(page, MAIN);
    await expandAll(page);
    await expectAxeClean(page, `${theme} desktop`);
    await expectNoOverflow(page, `${theme} desktop`);
    await page.goto(`${BASE}${REPO}`);
    await expect(page.getByTestId("api-specs")).toBeVisible();
    await expectAxeClean(page, `${theme} repo page`);
  });

  test(`phone width, ${theme} theme: no horizontal scroll, long paths wrap, targets`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await useTheme(page, theme);
    await open(page, MAIN);
    await expandAll(page);
    await expectNoOverflow(page, `${theme} phone`);
    await expectAxeClean(page, `${theme} phone`);
    const longPath: Locator = page.locator(
      ".api-reference .opblock-deprecated .opblock-summary-path__deprecated",
    );
    const box = await longPath.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(320);
    expect(box?.height ?? 0).toBeGreaterThan(40); // wrapped over several lines
  });
}

test("controls have a visible focus ring", async ({ page }) => {
  await open(page, MAIN);
  const control = page.locator(".api-reference .opblock-summary-control").first();
  await control.focus();
  const outline = await control.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});
