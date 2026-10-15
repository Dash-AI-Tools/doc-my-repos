import type { Locator, Page } from "@playwright/test";

import { type ThemeName } from "../src/lib/theme-tokens";
import { stubAssets } from "./support/assets";
import { expect, test } from "./support/csp";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Tasks 9.6 and 9.7: the docs table of contents on the repository page and the document page
 * `/<owner>/<repo>/docs/<path>`, in a real browser (Chromium) against the seeded database
 * (e2e/support/seed-data.ts: `acme/api-service` for the spec's nested folders, `acme/doc-showcase`
 * for the document page features).
 *
 * Screenshots go to `test-results/` (light and dark) for inspection.
 */

const KEY = "docmyrepos-theme";

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

const repoPath = (r: { owner: string; name: string }) => `/${r.owner}/${r.name}`;
const docPath = (r: { owner: string; name: string }, stem: string) => `${repoPath(r)}/docs/${stem}`;

const tree = (page: Page): Locator => page.getByTestId("docs-tree");

/** The disclosure button of the folder called `name`. */
function toggle(page: Page, name: string): Locator {
  return tree(page).getByRole("button", { name, exact: true });
}

/** The list item of the folder called `name`: its row, summary and entries. */
function folder(page: Page, name: string): Locator {
  return tree(page)
    .locator("li")
    .filter({ has: page.getByRole("button", { name, exact: true }) })
    .last();
}

const expanded = (page: Page, name: string): Locator => toggle(page, name);

const pager = (page: Page): Locator => page.getByTestId("doc-pager");

test.describe("docs table of contents and document pages, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("table of contents on the repository page (9.6)", () => {
    test("shows the spec's nested folders: guides > Setup, advanced > Tuning", async ({ page }) => {
      await page.goto(repoPath(SEEDED.full));
      const nav = page.getByRole("navigation", { name: "Documentation" });
      await expect(nav.getByText("Documentation", { exact: true })).toBeVisible();
      await expect(nav.getByTestId("docs-nav-count")).toHaveText("4 documents");

      await expect(expanded(page, "guides")).toHaveAttribute("aria-expanded", "true");
      const guides = folder(page, "guides");
      await expect(guides.getByRole("link", { name: "Setup" })).toBeVisible();
      // advanced is nested inside guides and starts closed
      await expect(expanded(page, "advanced")).toHaveAttribute("aria-expanded", "false");
      await expect(guides.getByRole("link", { name: "Tuning" })).toBeHidden();
      await toggle(page, "advanced").click();
      await expect(expanded(page, "advanced")).toHaveAttribute("aria-expanded", "true");
      const tuning = guides.getByRole("link", { name: "Tuning" });
      await expect(tuning).toBeVisible();
      await expect(tuning).toHaveAttribute("href", "/acme/api-service/docs/guides/advanced/tuning");
      // the docs root index comes first, then folders by name
      const topLevel = await tree(page)
        .locator(":scope > ul > li")
        .evaluateAll((items) =>
          items.map((li) =>
            (
              li.querySelector(":scope > button, :scope > a")?.textContent ?? li.textContent
            )?.trim(),
          ),
        );
      expect(topLevel).toEqual(["API documentation", "guides", "reference"]);
    });

    test("opens a document from the table of contents", async ({ page }) => {
      await page.goto(repoPath(SEEDED.full));
      await tree(page).getByRole("link", { name: "Setup" }).click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service/docs/guides/setup`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Setup");
    });

    test("collapses and expands a folder with the keyboard", async ({ page }) => {
      await page.goto(repoPath(SEEDED.full));
      const guides = folder(page, "guides");
      await toggle(page, "guides").focus();
      await page.keyboard.press("Enter");
      await expect(expanded(page, "guides")).toHaveAttribute("aria-expanded", "false");
      await expect(guides.getByRole("link", { name: "Setup" })).toBeHidden();
      await page.keyboard.press("Space");
      await expect(expanded(page, "guides")).toHaveAttribute("aria-expanded", "true");
      await expect(guides.getByRole("link", { name: "Setup" })).toBeVisible();
      // Tab moves from the toggle to the first entry of its folder
      await page.keyboard.press("Tab");
      await expect(guides.getByRole("link", { name: "Setup" })).toBeFocused();
    });

    test("expand all and collapse all work", async ({ page }) => {
      await page.goto(repoPath(SEEDED.full));
      const nav = page.getByTestId("docs-nav");
      await nav.getByRole("button", { name: "Collapse all" }).click();
      await expect(tree(page).getByRole("button", { expanded: true })).toHaveCount(0);
      // only the entries outside any folder are left (the docs root index)
      await expect(tree(page).getByRole("link")).toHaveText(["API documentation"]);
      await nav.getByRole("button", { name: "Expand all" }).click();
      await expect(tree(page).getByRole("button", { expanded: false })).toHaveCount(0);
      await expect(tree(page).getByRole("link", { name: "Tuning" })).toBeVisible();
    });

    test("is rendered with the right folders open before any script runs", async ({ browser }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        baseURL: stackUrl("seeded"),
      });
      const page = await context.newPage();
      await page.goto(docPath(SEEDED.full, "guides/advanced/tuning"));
      // the current page's folders are open in the HTML itself: no flash when the page hydrates
      await expect(tree(page).getByRole("link", { name: "Tuning" })).toBeVisible();
      await expect(tree(page).getByRole("link", { name: "Setup" })).toBeVisible();
      await expect(tree(page).locator('a[aria-current="page"]')).toHaveText("Tuning");
      await page.goto(repoPath(SEEDED.full));
      await expect(tree(page).getByRole("link", { name: "Setup" })).toBeVisible();
      await expect(tree(page).getByRole("link", { name: "Tuning" })).toBeHidden();
      await context.close();
    });

    test("without JavaScript on a phone, the document comes first and the lists follow it", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        baseURL: stackUrl("seeded"),
        viewport: { width: 375, height: 800 },
      });
      const page = await context.newPage();
      await page.goto(docPath(SEEDED.showcase, "guides/long-outline"));
      const article = await page.getByTestId("doc-article").boundingBox();
      const outline = page.getByTestId("outline");
      const nav = page.getByTestId("doc-nav");
      await expect(outline).toBeVisible();
      await expect(nav).toBeVisible();
      await expect(tree(page).getByRole("link", { name: "Getting started" })).toBeVisible();
      await expect(outline.getByRole("link", { name: "Section 12", exact: true })).toBeVisible();
      const outlineBox = await outline.boundingBox();
      const navBox = await nav.boundingBox();
      if (!article || !outlineBox || !navBox) throw new Error("missing layout boxes");
      expect(outlineBox.y).toBeGreaterThan(article.y + article.height - 1);
      expect(navBox.y).toBeGreaterThan(outlineBox.y);
      // nothing to press: the controls that need scripts are not offered
      await expect(page.getByTestId("doc-nav-close")).toBeHidden();
      await expect(page.getByTestId("outline-menu-list")).toBeHidden();
      await expect(page.getByTestId("doc-bar")).toBeHidden();
      await context.close();
    });

    test("a folder with an index.md links to it, without its description", async ({ page }) => {
      await page.goto(repoPath(SEEDED.showcase));
      const guides = folder(page, "guides");
      const link = guides.getByRole("link", { name: "guides", exact: true });
      await expect(link).toHaveAttribute("href", "/acme/doc-showcase/docs/guides/index");
      await expect(guides.getByText("How-to guides for operators.")).toHaveCount(0);
      // the index is the folder entry, not a child; a folder without one has no link
      await expect(guides.getByRole("link", { name: "Guides", exact: true })).toHaveCount(0);
      await expect(tree(page).getByRole("link", { name: "reference", exact: true })).toHaveCount(0);
      await link.click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/doc-showcase/docs/guides/index`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guides");
      await expect(tree(page).locator('a[aria-current="page"]')).toHaveText("guides");
    });

    test("a synced repository without docs says so; a never-synced one says something else", async ({
      page,
    }) => {
      await page.goto(repoPath(SEEDED.emptyDocs));
      const empty = page.getByTestId("docs-nav-empty");
      await expect(empty).toContainText("No documentation files found");
      await expect(empty).toContainText("docs/");
      await expect(page.getByTestId("docs-nav-pending")).toHaveCount(0);
      await expect(page.getByTestId("docs-tree")).toHaveCount(0);
      // Spec "No docs folder": the repository is still listed, with its README and code owners.
      await expect(
        page.getByTestId("readme-body").getByRole("heading", { level: 1, name: "empty-docs" }),
      ).toBeVisible();
      await expect(page.getByTestId("code-owners-empty")).toBeVisible();
      await page.goto("/");
      const listed = page.getByTestId("repo-card").filter({
        has: page.locator('a[href="/acme/empty-docs"]'),
      });
      await expect(listed).toHaveCount(1);
      await expect(listed).toContainText("No documents");

      await page.goto(repoPath(SEEDED.pending));
      await expect(page.getByTestId("docs-nav-pending")).toContainText("after the first sync");
      await expect(page.getByTestId("docs-nav-empty")).toHaveCount(0);
    });
  });

  test.describe("document page (9.7)", () => {
    test("renders the document with breadcrumb, source link, outline slot and no browser errors", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      const response = await page.goto(docPath(SEEDED.full, "guides/setup"));
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle("Setup · acme/api-service");
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        /\/acme\/api-service\/docs\/guides\/setup$/,
      );
      // one h1: the body's own "# Setup" repeats the title and is hidden
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Setup");
      await expect(page.getByTestId("doc-body").locator("h1")).toBeHidden();
      await expect(page.getByTestId("doc-body").locator("pre.shiki")).toHaveCount(1);

      const source = page.getByRole("link", { name: "View source on GitHub" });
      await expect(source).toHaveAttribute(
        "href",
        "https://github.com/acme/api-service/blob/main/docs/guides/setup.md",
      );
      await expect(source).toHaveAttribute("rel", "noopener noreferrer");
      await expect(page.getByTestId("doc-source-path")).toHaveText("docs/guides/setup.md");
      await expect(page.locator("time")).toHaveAttribute("datetime", "2026-03-14T09:30:00.000Z");

      const crumbs = page.getByTestId("doc-breadcrumb");
      await expect(crumbs.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
      await expect(crumbs.getByRole("link", { name: "acme/api-service" })).toHaveAttribute(
        "href",
        "/acme/api-service",
      );
      await expect(crumbs.getByText("guides")).toBeVisible();
      await expect(crumbs.locator("[aria-current=page]")).toHaveText("Setup");

      // the current page in the sidebar tree, with its folder open
      const current = tree(page).locator('a[aria-current="page"]');
      await expect(current).toHaveText("Setup");
      await expect(expanded(page, "guides")).toHaveAttribute("aria-expanded", "true");
      // a document with no h2 to h4 has no outline
      await expect(page.getByTestId("outline")).toHaveCount(0);
      expect(errors).toEqual([]);

      await crumbs.getByRole("link", { name: "acme/api-service" }).click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
    });

    test("previous and next follow the table of contents, from the first page to the last", async ({
      page,
    }) => {
      // order: API documentation (index), Setup, Tuning, Endpoints
      await page.goto(docPath(SEEDED.full, "index"));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("API documentation");
      await expect(pager(page).getByRole("link", { name: /Previous/ })).toHaveCount(0);
      const next = pager(page).getByRole("link", { name: /Next/ });
      await expect(next).toHaveAttribute("rel", "next");
      await expect(next).toContainText("Setup");

      await next.click();
      await expect(page).toHaveURL(/\/docs\/guides\/setup$/);
      await expect(pager(page).getByRole("link", { name: /Previous/ })).toContainText(
        "API documentation",
      );
      await expect(pager(page).getByRole("link", { name: /Previous/ })).toHaveAttribute(
        "rel",
        "prev",
      );
      await pager(page).getByRole("link", { name: /Next/ }).click();
      await expect(page).toHaveURL(/\/docs\/guides\/advanced\/tuning$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tuning");
      // nested folder opened in the tree, the current entry marked
      await expect(expanded(page, "advanced")).toHaveAttribute("aria-expanded", "true");
      await expect(tree(page).locator('a[aria-current="page"]')).toHaveText("Tuning");

      await pager(page).getByRole("link", { name: /Next/ }).click();
      await expect(page).toHaveURL(/\/docs\/reference\/endpoints$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Endpoints");
      // the last page has no next
      await expect(pager(page).getByRole("link", { name: /Next/ })).toHaveCount(0);
      await pager(page)
        .getByRole("link", { name: /Previous/ })
        .click();
      await expect(page).toHaveURL(/\/docs\/guides\/advanced\/tuning$/);
    });

    test("renders code, table, task list, footnote, image and diagram, and the outline jumps to a section", async ({
      page,
    }) => {
      const requested = await stubAssets(page);
      const errors = collectBrowserErrors(page);
      await page.goto(docPath(SEEDED.showcase, "guides/getting-started"));
      const body = page.getByTestId("doc-body");
      await expect(body.locator("pre.shiki")).toHaveCount(2);
      await expect(body.getByRole("button", { name: "Copy code" })).toHaveCount(2);
      await expect(body.locator("table")).toHaveCount(1);
      await expect(body.locator('input[type="checkbox"]')).toHaveCount(2);
      await expect(body.locator("section.footnotes")).toHaveCount(1);
      const image = body.getByRole("img", { name: "Architecture overview" });
      await expect(image).toHaveAttribute(
        "src",
        "/api/asset/acme/doc-showcase/docs/assets/architecture.png",
      );
      await expect
        .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      expect(requested).toContain("/api/asset/acme/doc-showcase/docs/assets/architecture.png");
      await expect(body.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
        timeout: 30_000,
      });
      // relative links to other docs are rewritten to document pages
      await expect(body.getByRole("link", { name: "long outline" })).toHaveAttribute(
        "href",
        "/acme/doc-showcase/docs/guides/long-outline",
      );

      // the outline lists h2 to h4 as links to the heading ids, nested by level
      const outline = page.getByRole("navigation", { name: "On this page" });
      const labels = await outline.getByRole("link").allTextContents();
      expect(labels).toEqual(["Install", "Checklist", "Options", "Environment", "Architecture"]);
      await expect(outline.getByRole("link", { name: "Environment" })).toHaveAttribute(
        "href",
        "#environment",
      );
      await expect(
        outline.locator("li", { has: page.getByRole("link", { name: "Options" }) }).locator("ul a"),
      ).toHaveText("Environment");

      await outline.getByRole("link", { name: "Options" }).click();
      await expect(page).toHaveURL(/#options$/);
      await expect(page.locator("#options")).toBeInViewport();
      await expect(outline.getByRole("link", { name: "Options" })).toHaveAttribute(
        "aria-current",
        "location",
      );
      expect(errors).toEqual([]);
    });

    test("a deep link to a heading scrolls to it and marks it in the outline", async ({ page }) => {
      await stubAssets(page);
      await page.goto(`${docPath(SEEDED.showcase, "guides/getting-started")}#checklist`);
      await expect(page.locator("#checklist")).toBeInViewport();
      await expect(
        page.getByRole("navigation", { name: "On this page" }).getByRole("link", {
          name: "Checklist",
        }),
      ).toHaveAttribute("aria-current", "location");
    });

    test("the outline follows the reader through a long document and stays on screen", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(docPath(SEEDED.showcase, "guides/long-outline"));
      const outline = page.getByRole("navigation", { name: "On this page" });
      await expect(outline.getByRole("link")).toHaveCount(14 * 3);
      await page.evaluate(() => document.getElementById("section-10")?.scrollIntoView());
      await expect(outline.getByRole("link", { name: "Section 10", exact: true })).toHaveAttribute(
        "aria-current",
        "location",
      );
      // exactly one entry is current
      await expect(outline.locator('[aria-current="location"]')).toHaveCount(1);
      // the current entry stays inside the sidebar's own scroll area (a 42-entry outline is taller
      // than the viewport)
      const inside = await page.evaluate(() => {
        const link = document.querySelector('[data-testid="outline"] [aria-current="location"]');
        const box = document.querySelector('[data-testid="doc-sidebar"]');
        if (!link || !box) return false;
        const a = link.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return a.top >= b.top && a.bottom <= b.bottom;
      });
      expect(inside).toBe(true);
      // the sidebar sticks to the viewport while the page scrolls
      await expect(page.getByTestId("doc-sidebar")).toBeInViewport();
      await expect(outline).toBeInViewport();
    });

    test("shows the frontmatter title as h1 and keeps a body heading that differs", async ({
      page,
    }) => {
      await page.goto(docPath(SEEDED.showcase, "notes/custom-title"));
      await expect(page).toHaveTitle("A custom title · acme/doc-showcase");
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1.first()).toHaveText("A custom title");
      await expect(page.getByTestId("doc-description")).toHaveText(
        "The title comes from the frontmatter.",
      );
      // the body's h1 is a different text, so it is shown as written
      await expect(page.getByTestId("doc-body").getByRole("heading", { level: 1 })).toHaveText(
        "A different heading",
      );
    });

    test("opens a file whose name has a space and a percent sign", async ({ page }) => {
      await page.goto(repoPath(SEEDED.showcase));
      await tree(page).getByRole("link", { name: "100% done" }).click();
      await expect(page).toHaveURL(/\/docs\/special\/100%25%20done$/);
      // the page decodes its address itself, generateMetadata gets it decoded: both agree
      await expect(page).toHaveTitle("100% done · acme/doc-showcase");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("100% done");
      await expect(page.getByTestId("doc-source-path")).toHaveText("docs/special/100% done.md");
      await expect(page.getByRole("link", { name: "View source on GitHub" })).toHaveAttribute(
        "href",
        "https://github.com/acme/doc-showcase/blob/main/docs/special/100%25%20done.md",
      );
    });

    test("the first and last page of a repository have one pager link each", async ({ page }) => {
      await page.goto(docPath(SEEDED.showcase, "overview"));
      await expect(pager(page).getByRole("link")).toHaveCount(1);
      await expect(pager(page).getByRole("link", { name: /Next/ })).toContainText("Guides");
      await page.goto(docPath(SEEDED.showcase, "special/tail"));
      await expect(pager(page).getByRole("link")).toHaveCount(1);
      await expect(pager(page).getByRole("link", { name: /Previous/ })).toContainText("100% done");
    });

    test("redirects to the canonical address: other case, and a folder with an index", async ({
      page,
    }) => {
      await page.goto("/ACME/Doc-Showcase/docs/GUIDES/Getting-Started");
      await expect(page).toHaveURL(
        `${stackUrl("seeded")}/acme/doc-showcase/docs/guides/getting-started`,
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Getting started");

      const response = await page.goto(docPath(SEEDED.showcase, "guides"));
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/doc-showcase/docs/guides/index`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guides");

      await page.goto("/acme/api-service/docs");
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
    });

    test("serves the breadcrumb link of a folder with an index and plain text otherwise", async ({
      page,
    }) => {
      await page.goto(docPath(SEEDED.showcase, "guides/long-outline"));
      await expect(
        page.getByTestId("doc-breadcrumb").getByRole("link", { name: "guides" }),
      ).toHaveAttribute("href", "/acme/doc-showcase/docs/guides/index");
      await page.goto(docPath(SEEDED.showcase, "reference/api"));
      await expect(
        page.getByTestId("doc-breadcrumb").getByText("reference", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByTestId("doc-breadcrumb").getByRole("link", { name: "reference" }),
      ).toHaveCount(0);
    });
  });

  test.describe("not found (9.7)", () => {
    test("a missing document gives a 404 page that links back to the repository space", async ({
      page,
    }) => {
      const response = await page.goto(docPath(SEEDED.full, "guides/does-not-exist"));
      expect(response?.status()).toBe(404);
      await expect(page).toHaveTitle("Document not found · DocMyRepos");
      const box = page.getByTestId("doc-not-found");
      await expect(box.getByRole("heading", { level: 1 })).toHaveText("Document not found");
      await box.getByRole("link", { name: "Back to the repository" }).click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
      await expect(page.getByTestId("repo-header")).toBeVisible();
    });

    test("a folder without an index.md, an unknown repository, a reserved owner and hostile paths are 404", async ({
      page,
    }) => {
      for (const path of [
        docPath(SEEDED.showcase, "special"),
        "/acme/nope/docs/x",
        "/search/x/docs/y",
        "/acme/doc-showcase/docs/..%2F..%2Fetc%2Fpasswd",
        "/acme/doc-showcase/docs/overview.md",
        "/acme/doc-showcase/docs/guides/getting-started%00",
        `/acme/empty-docs/docs/overview`,
        `/acme/brand-new/docs/overview`,
      ]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(404);
        await expect(page.getByTestId("doc-not-found"), path).toBeVisible();
      }
    });

    test("does not reveal anything about a hidden address in the page", async ({ page }) => {
      await page.goto("/acme/api-service/docs/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
      await expect(page.getByTestId("doc-not-found")).not.toContainText("script");
    });
  });

  test.describe("layout and themes", () => {
    const LONG = docPath(SEEDED.showcase, "guides/long-outline");
    const box = async (page: Page, testId: string) => {
      const b = await page.getByTestId(testId).boundingBox();
      if (!b) throw new Error(`no box for ${testId}`);
      return b;
    };
    const sideways = (page: Page) =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

    test("shows three columns at 1440 and keeps both rails in view while scrolling", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(LONG);
      await page.screenshot({ path: testInfo.outputPath("reader-1440.png") });
      const nav = await box(page, "doc-nav");
      const article = await box(page, "doc-article");
      const outline = await box(page, "doc-sidebar");
      expect(nav.x + nav.width).toBeLessThanOrEqual(article.x);
      expect(outline.x).toBeGreaterThanOrEqual(article.x + article.width - 1);
      await expect(page.getByTestId("doc-bar")).toBeHidden();
      await expect(page.getByTestId("doc-nav-toggle")).toBeHidden();
      await expect(page.getByTestId("outline-menu")).toBeHidden();
      await expect(page.getByTestId("doc-nav-close")).toBeHidden();
      await page.evaluate(() => window.scrollTo(0, 1500));
      await expect(page.getByTestId("doc-nav")).toBeInViewport();
      await expect(page.getByTestId("outline")).toBeInViewport();
    });

    test("uses the full viewport width at 2560, with the content column centred, and only there", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 2560, height: 1200 });
      await page.goto(LONG);
      await page.screenshot({ path: testInfo.outputPath("reader-2560.png") });
      const pad = 64; // lg:px-16, the side padding of the header, the page and the footer
      const nav = await box(page, "doc-nav");
      const outline = await box(page, "doc-sidebar");
      const article = await box(page, "doc-article");
      expect(Math.abs(nav.x - pad)).toBeLessThanOrEqual(1);
      expect(Math.abs(outline.x + outline.width - (2560 - pad))).toBeLessThanOrEqual(1);
      // the content keeps its line length and sits in the middle of the space between the rails
      expect(article.width).toBeLessThanOrEqual(60 * 16 + 1);
      const gap = (outline.x - (nav.x + nav.width) - article.width) / 2;
      expect(Math.abs(article.x - (nav.x + nav.width + gap))).toBeLessThanOrEqual(24);
      // the header spans the same width: its search/theme cluster ends at the same right edge
      const cluster = await page.getByTestId("palette-trigger").boundingBox();
      const header = await page.locator("header").first().boundingBox();
      if (!cluster || !header) throw new Error("missing header boxes");
      expect(header.width).toBe(2560);
      expect(cluster.x).toBeGreaterThan(1280);
      // other pages keep the limited width
      await page.goto("/");
      const main = await page.locator("main").boundingBox();
      if (!main) throw new Error("no main");
      expect(main.width).toBeLessThanOrEqual(88 * 16 + 1);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test("shows two columns at 1100: structure on the left, headings as a dropdown", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.goto(LONG);
      await page.screenshot({ path: testInfo.outputPath("reader-1100.png") });
      const nav = await box(page, "doc-nav");
      const article = await box(page, "doc-article");
      expect(nav.x + nav.width).toBeLessThanOrEqual(article.x);
      await expect(page.getByTestId("doc-sidebar")).toBeHidden();
      await expect(page.getByTestId("doc-nav-toggle")).toBeHidden();
      const menu = page.getByTestId("outline-menu");
      await expect(menu).toBeVisible();
      const bar = await box(page, "doc-bar");
      expect(bar.y).toBeLessThan(article.y);
      await menu.getByRole("button", { name: "On this page" }).click();
      await page.screenshot({ path: testInfo.outputPath("reader-1100-menu.png") });
      await menu.getByRole("link", { name: "Section 12", exact: true }).click();
      await expect(menu.getByTestId("outline-menu-list")).toBeHidden();
      await expect(page.locator("#section-12")).toBeInViewport();
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test("is one column at 375: hamburger panel, headings dropdown, bar stays reachable", async ({
      page,
    }, testInfo) => {
      // no slide animation: the panel is in place as soon as it is open
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(LONG);
      const toggle = page.getByTestId("doc-nav-toggle");
      const panel = page.getByTestId("doc-nav");
      await expect(page.getByTestId("doc-bar")).toBeVisible();
      await expect(toggle).toBeVisible();
      await expect(panel).toBeHidden();
      await expect(page.getByTestId("doc-sidebar")).toBeHidden();
      const article = await box(page, "doc-article");
      expect(article.x).toBeGreaterThanOrEqual(0);
      expect(article.x + article.width).toBeLessThanOrEqual(375);
      expect(await sideways(page)).toBeLessThanOrEqual(0);

      // the hamburger opens the panel with focus inside; Esc closes it and focus comes back
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("role", "dialog");
      await expect(page.getByTestId("doc-nav-close")).toBeFocused();
      await expect(page.getByTestId("docs-tree")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("reader-375-panel.png") });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(toggle).toBeFocused();

      // Tab stays inside the open panel
      await toggle.click();
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() =>
          document.querySelector('[data-testid="doc-nav"]')?.contains(document.activeElement),
        );
        expect(inside).toBe(true);
      }
      // the backdrop closes it, and the page behind did not scroll meanwhile
      await page.mouse.click(360, 400);
      await expect(panel).toBeHidden();

      // choosing a document closes the panel and opens that document
      await toggle.click();
      const overview = panel.getByRole("link", { name: "Overview" }).first();
      const href = await overview.getAttribute("href");
      expect(href).not.toBeNull();
      expect(href).not.toBe(new URL(LONG, page.url()).pathname);
      await overview.click();
      await expect(page).toHaveURL((url) => url.pathname === href);
      await expect(page.getByTestId("doc-nav")).toBeHidden();

      // the bar stays under the site header while the document scrolls, and the headings
      // dropdown lands on a heading that is fully visible
      await page.goto(LONG);
      await page.evaluate(() => window.scrollTo(0, 1200));
      const header = await page.locator("header").first().boundingBox();
      const bar = await box(page, "doc-bar");
      if (!header) throw new Error("no header");
      expect(Math.abs(bar.y - (header.y + header.height))).toBeLessThanOrEqual(1);
      const menu = page.getByTestId("outline-menu");
      await menu.getByRole("button", { name: "On this page" }).click();
      await page.screenshot({ path: testInfo.outputPath("reader-375-menu.png") });
      await menu.getByRole("link", { name: "Section 12", exact: true }).click();
      await expect(menu.getByTestId("outline-menu-list")).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath("reader-375-jumped.png") });
      const target = page.locator("#section-12");
      await expect(target).toBeInViewport();
      const top = (await target.boundingBox())?.y ?? 0;
      const bar2 = await box(page, "doc-bar");
      expect(top).toBeGreaterThanOrEqual(bar2.y + bar2.height - 1);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test("closes the headings dropdown with Esc and a press outside, scrolling when long", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 600 });
      await page.goto(LONG);
      const menu = page.getByTestId("outline-menu");
      const button = menu.getByRole("button", { name: "On this page" });
      const list = menu.getByTestId("outline-menu-list");
      await button.click();
      await expect(list).toBeVisible();
      const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(scrolls).toBe(true);
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
      await expect(button).toBeFocused();
      await button.click();
      // A plain content point outside the open list (the list covers much of a phone screen).
      const outside = await page.evaluate(() => {
        const box = document
          .querySelector("[data-testid=outline-menu-list]")!
          .getBoundingClientRect();
        for (let y = 120; y < innerHeight; y += 8) {
          for (let x = 4; x < innerWidth; x += 8) {
            if (x > box.left - 2 && x < box.right + 2 && y > box.top - 2 && y < box.bottom + 2)
              continue;
            const el = document.elementFromPoint(x, y);
            if (
              el &&
              !el.closest("a, button, [data-testid=outline-menu-list]") &&
              ["P", "H1", "H2", "DIV", "MAIN", "ARTICLE"].includes(el.tagName)
            )
              return { x, y };
          }
        }
        return null;
      });
      expect(outside).not.toBeNull();
      await page.mouse.click(outside!.x, outside!.y);
      await expect(list).toBeHidden();
    });

    for (const theme of ["light", "dark"] as const) {
      test(`screenshots in the ${theme} theme`, async ({ page }, testInfo) => {
        await stubAssets(page);
        await setTheme(page, theme);
        await page.setViewportSize({ width: 1280, height: 900 });

        await page.goto(repoPath(SEEDED.showcase));
        await expect(page.getByTestId("docs-tree")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`repo-toc-${theme}.png`),
          fullPage: true,
        });

        await page.goto(docPath(SEEDED.showcase, "guides/getting-started"));
        await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
          timeout: 30_000,
        });
        await page.screenshot({
          path: testInfo.outputPath(`doc-getting-started-${theme}.png`),
          fullPage: true,
        });

        await page.goto(docPath(SEEDED.showcase, "guides/long-outline"));
        await page.locator("#section-6").scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`doc-long-outline-${theme}.png`) });

        await page.goto(docPath(SEEDED.full, "missing"));
        await expect(page.getByTestId("doc-not-found")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`doc-not-found-${theme}.png`) });

        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto(docPath(SEEDED.showcase, "guides/long-outline"));
        await page.screenshot({ path: testInfo.outputPath(`doc-mobile-${theme}.png`) });
      });
    }
  });
});
