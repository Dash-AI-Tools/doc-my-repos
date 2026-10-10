import { expect, test, type Locator, type Page } from "@playwright/test";

import { type ThemeName } from "../src/lib/theme-tokens";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Task 10.3: the `/search` page in a real browser (Chromium) against the seeded database
 * (e2e/support/seed-data.ts: the word "deployment" appears in a title, a heading, a tag and several
 * bodies across five repositories; `acme/search-lab` holds a markup-heavy doc, a hostile
 * frontmatter title and 25 "changelog" documents for paging).
 *
 * Expected counts come from the seed (see the header of seed-data.ts). Screenshots go to
 * `test-results/` (light and dark) for inspection.
 */

const KEY = "docmyrepos-theme";
const DEPLOYMENT_URL = "/search?q=deployment";
const API = SEEDED.full; // acme/api-service
const KB = SEEDED.okf; // acme/knowledge-base (OKF)

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

const titles = (page: Page): Promise<string[]> => page.getByTestId("result-link").allTextContents();
const results = (page: Page): Locator => page.getByTestId("result");
const summary = (page: Page): Locator => page.getByTestId("result-summary");

function group(page: Page, kind: "repo" | "type" | "tag" | "status"): Locator {
  return page.getByTestId(`facet-group-${kind}`);
}

/** The facet option link whose label starts with `label` (counts and hidden text follow it). */
function option(page: Page, kind: "repo" | "type" | "tag" | "status", label: string): Locator {
  return group(page, kind)
    .getByTestId("facet-option")
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** `[label, count]` of every option of a group, in the order shown. */
async function counts(page: Page, kind: "repo" | "type" | "tag" | "status") {
  const rows = await group(page, kind)
    .getByTestId("facet-option")
    .evaluateAll((els) =>
      els.map((el) => [
        el.querySelector("span.min-w-0")?.textContent ?? "",
        Number(el.querySelector("[data-testid=facet-count]")?.firstChild?.textContent),
      ]),
    );
  return rows as [string, number][];
}

async function xssRan(page: Page): Promise<boolean> {
  return page.evaluate(() => "__xss" in window);
}

test.describe("search page, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("results", () => {
    test("ranks a title match first, then headings, tags and bodies (spec: Title outranks body)", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      const response = await page.goto(DEPLOYMENT_URL);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle('"deployment" · Search');
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Search");
      await expect(results(page)).toHaveCount(10);

      const all = await titles(page);
      // title (A), heading (B), tag (C), then the seven body matches (D)
      expect(all.slice(0, 3)).toEqual(["Deployment", "Operations", "Release pipeline"]);
      expect([...all.slice(3)].sort()).toEqual(
        [
          "Deploys",
          "Markup showcase",
          "Release windows",
          "Rollback",
          "Setup",
          "Terms",
          "Use Postgres",
        ].sort(),
      );
      // the titled document is first in its own repository and across all of them
      await expect(results(page).first()).toContainText("acme/search-lab");
      await expect(results(page).first()).toContainText("docs/deployment.md");
      expect(errors).toEqual([]);
    });

    test("shows title, repository, path and a snippet, each linking to the right place", async ({
      page,
    }) => {
      await page.goto(DEPLOYMENT_URL);
      const first = results(page).first();
      const link = first.getByTestId("result-link");
      await expect(link).toHaveText("Deployment");
      await expect(link).toHaveAttribute("href", "/acme/search-lab/docs/deployment");
      await expect(first.getByTestId("result-repo")).toHaveText("acme/search-lab");
      await expect(first.getByTestId("result-repo")).toHaveAttribute("href", "/acme/search-lab");
      await expect(first.getByTestId("result-path")).toHaveText("docs/deployment.md");
      await expect(first.getByTestId("result-snippet")).toContainText("Ship the service");
    });

    test("highlights matched terms with <mark> and shows no Markdown or HTML markup", async ({
      page,
    }) => {
      await page.goto(DEPLOYMENT_URL);
      const markup = results(page).filter({ hasText: "Markup showcase" });
      const snippet = markup.getByTestId("result-snippet");
      const marks = snippet.locator("mark");
      expect(await marks.count()).toBeGreaterThanOrEqual(3);
      for (const text of await marks.allTextContents())
        expect(text.toLowerCase()).toBe("deployment");
      // the source has **bold**, a [link](url), `code`, <span> html, a table and a code fence
      const text = (await snippet.textContent()) ?? "";
      expect(text).toContain("bold deployment notes");
      expect(text).not.toMatch(/\*\*|\]\(|`|<\/?span|<\/?[a-z]+[ >]|\|\s*-{3}|https?:\/\//);
      // nothing in any snippet is an element other than mark/span text
      expect(await page.locator("[data-testid=result-snippet] :not(mark):not(span)").count()).toBe(
        0,
      );
      // every body match is highlighted somewhere on the page
      for (const row of await results(page).all()) {
        const title = await row.getByTestId("result-link").textContent();
        if (title === "Deploys" || title === "Setup") {
          await expect(row.locator("mark")).toHaveText("deployment");
        }
      }
    });

    test("shows type, status and tags for OKF documents only", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      const rollback = results(page).filter({ hasText: "docs/runbooks/rollback.md" });
      await expect(rollback.getByTestId("result-type")).toHaveText("Type: Runbook");
      await expect(rollback.getByTestId("result-status")).toHaveText("Status: deprecated");
      await expect(rollback.getByTestId("result-tag")).toHaveText([
        "Tag: infrastructure",
        "Tag: oncall",
      ]);
      const plain = results(page).filter({ hasText: "docs/guides/setup.md" });
      await expect(plain.getByTestId("result-type")).toHaveCount(0);
      await expect(plain.getByTestId("result-status")).toHaveCount(0);
      await expect(plain.getByTestId("result-tag")).toHaveCount(0);
    });

    test("badges results of private repositories only", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await expect(page.getByTestId("private-badge")).toHaveCount(2);
      const deploys = results(page).filter({ hasText: "docs/deploys.md" });
      await expect(deploys.getByTestId("private-badge")).toHaveText("Private");
      await expect(deploys.getByTestId("result-repo")).toHaveText("acme/internal-tools");
      const handbook = results(page).filter({ hasText: "globex/handbook" });
      await expect(handbook.getByTestId("private-badge")).toBeVisible();
      await expect(
        results(page).filter({ hasText: "docs/guides/setup.md" }).getByTestId("private-badge"),
      ).toHaveCount(0);
    });

    test("matches a phrase in the body (spec: Match in body)", async ({ page }) => {
      await page.goto("/search?q=rate%20limit");
      await expect(titles(page)).resolves.toEqual(["Throttling"]);
      await expect(results(page).first().locator("mark")).toHaveText(["rate", "limit"]);
    });

    test("describes the count in a polite live region", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      const status = page.getByRole("status");
      await expect(status).toHaveText("Showing 1–10 of 10 results for “deployment”");
      await expect(status).toHaveAttribute("aria-live", "polite");
    });

    test("is not indexed by search engines", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    });
  });

  test.describe("facets", () => {
    test("shows a count for every value, consistent with the results", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      const repos = await counts(page, "repo");
      expect(repos).toEqual([
        ["acme/knowledge-base", 4],
        ["acme/search-lab", 3],
        ["acme/api-service", 1],
        ["acme/internal-tools", 1],
        ["globex/handbook", 1],
      ]);
      // every document is in exactly one repository: the counts add up to the total
      expect(repos.reduce((sum, [, n]) => sum + n, 0)).toBe(10);
      await expect(page.getByTestId("result-total")).toHaveText("10");
      // type, tag and status are exact and case-sensitive: concept and Concept stay apart
      expect(await counts(page, "type")).toEqual([
        ["Concept", 1],
        ["Decision", 1],
        ["Runbook", 1],
        ["concept", 1],
        ["policy", 1],
      ]);
      expect(await counts(page, "status")).toEqual([
        ["active", 3],
        ["deprecated", 1],
        ["draft", 1],
      ]);
      expect((await counts(page, "tag"))[0]).toEqual(["infrastructure", 2]);
    });

    test("every option is a real link to the URL with that value toggled", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await expect(option(page, "repo", "acme/api-service")).toHaveAttribute(
        "href",
        "/search?q=deployment&repo=acme%2Fapi-service",
      );
      await expect(option(page, "type", "Runbook")).toHaveAttribute(
        "href",
        "/search?q=deployment&type=Runbook",
      );
    });

    test("selecting a repository narrows the results and updates the URL (spec: Repository filter)", async ({
      page,
    }) => {
      await page.goto(DEPLOYMENT_URL);
      await option(page, "repo", "acme/api-service").click();
      await expect(page).toHaveURL(/\/search\?q=deployment&repo=acme%2Fapi-service$/);
      await expect(results(page)).toHaveCount(1);
      await expect(titles(page)).resolves.toEqual(["Setup"]);
      await expect(results(page).first()).toContainText(`${API.owner}/${API.name}`);
      await expect(summary(page)).toHaveText("Showing 1 of 1 result for “deployment”");
      // the selected value is first, marked, and the other repositories keep their counts
      const selected = option(page, "repo", "acme/api-service");
      await expect(selected).toHaveAttribute("aria-current", "true");
      await expect(selected).toContainText("selected, press to remove this filter");
      expect((await counts(page, "repo"))[0]).toEqual(["acme/api-service", 1]);
      expect(await counts(page, "repo")).toContainEqual(["acme/knowledge-base", 4]);
      // plain-Markdown results: no OKF groups
      await expect(group(page, "type")).toHaveCount(0);
      await expect(group(page, "tag")).toHaveCount(0);
      await expect(group(page, "status")).toHaveCount(0);
      await expect(page.getByTestId("active-filter")).toHaveCount(1);
    });

    test("a type filter on the OKF repository narrows further, and combines with a tag", async ({
      page,
    }) => {
      await page.goto(DEPLOYMENT_URL);
      await option(page, "repo", `${KB.owner}/${KB.name}`).click();
      await expect(results(page)).toHaveCount(4);
      await expect(page).toHaveURL(/q=deployment&repo=acme%2Fknowledge-base$/);

      await option(page, "type", "Runbook").click();
      await expect(page).toHaveURL(/q=deployment&repo=acme%2Fknowledge-base&type=Runbook$/);
      await expect(titles(page)).resolves.toEqual(["Rollback"]);
      // other types keep their counts within the repository
      expect(await counts(page, "type")).toContainEqual(["Decision", 1]);

      // OR within a kind: adding a second type widens the selection
      await option(page, "type", "Decision").click();
      await expect(page).toHaveURL(/type=Decision&type=Runbook$/);
      await expect(results(page)).toHaveCount(2);

      // AND across kinds: the tag narrows the two types to the ones with it
      await option(page, "tag", "oncall").click();
      await expect(page).toHaveURL(/tag=oncall&type=Decision&type=Runbook$/);
      await expect(titles(page)).resolves.toEqual(["Rollback"]);
      await option(page, "status", "deprecated").click();
      await expect(page).toHaveURL(/status=deprecated&tag=oncall/);
      await expect(titles(page)).resolves.toEqual(["Rollback"]);
    });

    test("a filter removes with its chip, and Clear all removes every filter", async ({ page }) => {
      await page.goto(`${DEPLOYMENT_URL}&repo=acme%2Fknowledge-base&type=Runbook`);
      await expect(results(page)).toHaveCount(1);
      const chips = page.getByTestId("active-filter");
      await expect(chips).toHaveCount(2);
      await expect(chips.first()).toContainText("Remove filter Repository: acme/knowledge-base");

      await page.getByRole("link", { name: "Remove filter Type: Runbook" }).click();
      await expect(page).toHaveURL(/\/search\?q=deployment&repo=acme%2Fknowledge-base$/);
      await expect(results(page)).toHaveCount(4);

      await page.goto(`${DEPLOYMENT_URL}&repo=acme%2Fknowledge-base&type=Runbook`);
      await page.getByTestId("clear-filters").click();
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(results(page)).toHaveCount(10);
      await expect(page.getByTestId("active-filters")).toHaveCount(0);
    });

    test("deselecting through the facet link itself removes the filter", async ({ page }) => {
      await page.goto(`${DEPLOYMENT_URL}&repo=acme%2Fapi-service`);
      await option(page, "repo", "acme/api-service").click();
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(results(page)).toHaveCount(10);
    });

    test("collapses a long facet list behind Show more", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      const more = page.getByTestId("facet-more-tag");
      await expect(more).toBeVisible();
      await expect(more.locator("summary")).toHaveText(/Show 1 more/);
      await expect(more.getByTestId("facet-option")).toBeHidden();
      await more.locator("summary").click();
      await expect(more.getByTestId("facet-option")).toBeVisible();
      await expect(more.locator("summary")).toHaveText(/Show fewer/);
      // the repository list is short: nothing to collapse
      await expect(page.getByTestId("facet-more-repo")).toHaveCount(0);
    });

    test("shows no OKF groups for results without type, tag or status", async ({ page }) => {
      await page.goto("/search?q=changelog");
      await expect(group(page, "repo")).toBeVisible();
      await expect(group(page, "type")).toHaveCount(0);
      await expect(group(page, "tag")).toHaveCount(0);
      await expect(group(page, "status")).toHaveCount(0);
    });

    test("a filter that matches nothing keeps the page usable and removable", async ({ page }) => {
      await page.goto(`${DEPLOYMENT_URL}&type=NoSuchType`);
      await expect(page.getByTestId("no-results")).toBeVisible();
      await expect(page.getByTestId("active-filter")).toContainText("Type: NoSuchType");
      await page.getByTestId("remove-filters").click();
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(results(page)).toHaveCount(10);
    });
  });

  test.describe("shareable URLs", () => {
    test("reload restores the query and filters", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await option(page, "repo", "acme/knowledge-base").click();
      await option(page, "type", "Runbook").click();
      await expect(page).toHaveURL(/type=Runbook$/);
      const url = page.url();
      const before = await titles(page);
      await page.reload();
      expect(page.url()).toBe(url);
      expect(await titles(page)).toEqual(before);
      await expect(page.getByRole("searchbox")).toHaveValue("deployment");
      await expect(option(page, "type", "Runbook")).toHaveAttribute("aria-current", "true");
    });

    test("the copied URL shows identical results in a fresh browser context", async ({
      page,
      browser,
    }) => {
      await page.goto(DEPLOYMENT_URL);
      await option(page, "repo", "acme/knowledge-base").click();
      await option(page, "status", "active").click();
      await expect(page).toHaveURL(/q=deployment&repo=acme%2Fknowledge-base&status=active$/);
      const expected = await titles(page);
      const expectedSummary = await summary(page).textContent();
      expect(expected.length).toBeGreaterThan(0);

      const fresh = await browser.newContext({ baseURL: stackUrl("seeded") });
      try {
        const other = await fresh.newPage();
        await other.goto(page.url());
        expect(await titles(other)).toEqual(expected);
        expect(await summary(other).textContent()).toBe(expectedSummary);
        await expect(other.getByTestId("active-filter")).toHaveCount(2);
      } finally {
        await fresh.close();
      }
    });

    test("the same state in a different parameter order shows the same results", async ({
      page,
    }) => {
      await page.goto("/search?type=Runbook&repo=acme/knowledge-base&q=deployment");
      await expect(titles(page)).resolves.toEqual(["Rollback"]);
      await expect(option(page, "type", "Runbook")).toHaveAttribute("aria-current", "true");
      // links are canonical whatever the order the page was opened with
      await expect(page.getByTestId("clear-filters")).toHaveAttribute(
        "href",
        "/search?q=deployment",
      );
    });

    test("back and forward move between states", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await option(page, "repo", "acme/api-service").click();
      await expect(results(page)).toHaveCount(1);
      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(results(page)).toHaveCount(10);
      await page.goForward();
      await expect(results(page)).toHaveCount(1);
    });

    test("a new query from the form keeps the filters and drops the page", async ({ page }) => {
      await page.goto("/search?q=changelog&page=2&repo=acme%2Fsearch-lab");
      await expect(results(page)).toHaveCount(5);
      await page.getByRole("searchbox").fill("rate limit");
      await page.getByRole("searchbox").press("Enter");
      await expect(page).toHaveURL(
        /\/search\?q=rate\+limit&repo=acme%2Fsearch-lab$|\/search\?q=rate%20limit&repo=acme%2Fsearch-lab$/,
      );
      await expect(titles(page)).resolves.toEqual(["Throttling"]);
    });

    test("the home page search bar lands on /search?q=", async ({ page }) => {
      await page.goto("/");
      const form = page.getByRole("search", { name: "Search documentation" });
      await form.getByRole("searchbox").fill("deployment");
      await form.getByRole("button", { name: "Search" }).click();
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(results(page)).toHaveCount(10);
      await expect(page.getByRole("searchbox")).toHaveValue("deployment");
    });
  });

  test.describe("empty and unusual queries", () => {
    test("no query shows how to search, without facets", async ({ page }) => {
      const response = await page.goto("/search");
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle("Search · DocMyRepos");
      await expect(page.getByTestId("no-query")).toBeVisible();
      await expect(page.getByTestId("facet-panel")).toHaveCount(0);
      await expect(results(page)).toHaveCount(0);
    });

    test("no results shows an empty state with the query echoed back (spec: No results)", async ({
      page,
    }) => {
      await page.goto("/search?q=zzzznothing");
      const empty = page.getByTestId("no-results");
      await expect(empty).toBeVisible();
      await expect(empty.getByTestId("echoed-query")).toHaveText("zzzznothing");
      await expect(page.getByRole("searchbox")).toHaveValue("zzzznothing");
      await expect(summary(page)).toHaveText("No results for “zzzznothing”");
      await expect(results(page)).toHaveCount(0);
      await expect(empty).toContainText("Check the spelling");
    });

    test("special characters never produce an error page (spec: Special characters)", async ({
      page,
    }) => {
      const queries = [
        '"unclosed & | ! ( ',
        '"',
        "-",
        "- -",
        "OR",
        "or or or",
        ")(",
        "<script>window.__xss=1</script>",
        "%",
        "%%20%",
        "100%",
        "\\",
        "'; drop table documents; --",
        "*:*",
        "a".repeat(5000),
        "日本語 ünïcödé 😀",
      ];
      for (const q of queries) {
        const errors = collectBrowserErrors(page);
        const response = await page.goto(`/search?q=${encodeURIComponent(q)}`);
        expect(response?.status(), q.slice(0, 20)).toBe(200);
        await expect(page.getByRole("heading", { level: 1 }), q.slice(0, 20)).toHaveText("Search");
        await expect(page.getByTestId("search-error")).toHaveCount(0);
        await expect(page.getByTestId("error-boundary")).toHaveCount(0);
        // either results or the empty state
        await expect(results(page).or(page.getByTestId("no-results"))).not.toHaveCount(0);
        expect(await xssRan(page)).toBe(false);
        expect(errors, q.slice(0, 20)).toEqual([]);
      }
    });

    test("hostile filter and paging parameters are ignored or empty, not an error", async ({
      page,
    }) => {
      for (const query of [
        "q=deployment&repo=%00&type=%00&status=",
        "q=deployment&page=-1&limit=abc",
        "q=deployment&page=99999999999999999999",
        `q=deployment&repo=${"x".repeat(5000)}`,
        "q=deployment&repo=a/b/c&repo=/&repo=a//b",
        "q=deployment&__proto__[q]=x&constructor[prototype]=y",
      ]) {
        const response = await page.goto(`/search?${query}`);
        expect(response?.status(), query.slice(0, 40)).toBe(200);
        await expect(page.getByTestId("search-error")).toHaveCount(0);
        await expect(results(page)).toHaveCount(10);
      }
      // a malformed escape is kept as the literal text it is: a tag nobody has
      const response = await page.goto("/search?q=deployment&tag=%ZZ");
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("no-results")).toBeVisible();
    });

    test("a hostile query is echoed as escaped text and runs nothing", async ({ page }) => {
      const hostile =
        '<script>window.__xss=1</script><img src=x onerror="window.__xss=2"><b>bold</b>';
      await page.goto(`/search?q=${encodeURIComponent(hostile)}`);
      const empty = page.getByTestId("no-results");
      await expect(empty.getByTestId("echoed-query")).toHaveText(hostile);
      await expect(page.getByRole("searchbox")).toHaveValue(hostile);
      expect(await page.locator("main script, main img, main b").count()).toBe(0);
      expect(await xssRan(page)).toBe(false);
      await expect(page).toHaveTitle(`"${Array.from(hostile).slice(0, 60).join("")}…" · Search`);
    });

    test("a hostile document title is shown as text", async ({ page }) => {
      await page.goto("/search?q=gateway");
      const title = results(page).first().getByTestId("result-link");
      await expect(title).toHaveText('<script>window.__xss = 1</script> & "quotes" gateway');
      expect(await page.locator("main script").count()).toBe(0);
      expect(await xssRan(page)).toBe(false);
      await expect(results(page).first().locator("mark")).toHaveText("gateway");
    });
  });

  test.describe("paging", () => {
    test("pages forward and back through 25 results with counts and canonical URLs", async ({
      page,
    }) => {
      await page.goto("/search?q=changelog");
      await expect(results(page)).toHaveCount(20);
      await expect(summary(page)).toHaveText("Showing 1–20 of 25 results for “changelog”");
      await expect(page.getByTestId("page-position")).toHaveText("Page 1 of 2");
      await expect(page.getByTestId("page-prev")).toHaveCount(0);
      const firstPage = await titles(page);
      expect(firstPage[0]).toBe("Release 01");
      expect(firstPage[19]).toBe("Release 20");

      await page.getByTestId("page-next").click();
      await expect(page).toHaveURL(/\/search\?page=2&q=changelog$/);
      await expect(results(page)).toHaveCount(5);
      await expect(summary(page)).toHaveText("Showing 21–25 of 25 results for “changelog”");
      await expect(page.getByTestId("page-next")).toHaveCount(0);
      expect(await titles(page)).toEqual([
        "Release 21",
        "Release 22",
        "Release 23",
        "Release 24",
        "Release 25",
      ]);

      await page.getByTestId("page-prev").click();
      await expect(page).toHaveURL(/\/search\?q=changelog$/);
      expect(await titles(page)).toEqual(firstPage);
    });

    test("the page size can be set in the URL and is kept by the links", async ({ page }) => {
      await page.goto("/search?q=changelog&limit=10");
      await expect(results(page)).toHaveCount(10);
      await expect(page.getByTestId("page-position")).toHaveText("Page 1 of 3");
      await page.getByTestId("page-next").click();
      await expect(page).toHaveURL(/\/search\?limit=10&page=2&q=changelog$/);
      await page.getByTestId("page-next").click();
      await expect(page).toHaveURL(/\/search\?limit=10&page=3&q=changelog$/);
      await expect(results(page)).toHaveCount(5);
      await expect(summary(page)).toHaveText("Showing 21–25 of 25 results for “changelog”");
    });

    test("filters survive paging and paging resets when a filter changes", async ({ page }) => {
      await page.goto("/search?page=2&q=changelog&repo=acme%2Fsearch-lab");
      await expect(results(page)).toHaveCount(5);
      await expect(page.getByTestId("page-prev")).toHaveAttribute(
        "href",
        "/search?q=changelog&repo=acme%2Fsearch-lab",
      );
      await option(page, "repo", "acme/search-lab").click();
      await expect(page).toHaveURL(/\/search\?q=changelog$/);
      await expect(results(page)).toHaveCount(20);
    });

    test("a page past the end says so and links to the last page", async ({ page }) => {
      await page.goto("/search?page=9&q=changelog");
      await expect(page.getByTestId("page-out-of-range")).toContainText(
        "Page 9 is past the last page",
      );
      await expect(page.getByTestId("no-results")).toHaveCount(0);
      await expect(results(page)).toHaveCount(0);
      await expect(summary(page)).toContainText("25 results");
      await page.getByTestId("page-prev").click();
      await expect(page).toHaveURL(/\/search\?page=2&q=changelog$/);
      await expect(results(page)).toHaveCount(5);
    });

    test("a page far beyond the deepest browsable offset is handled the same way", async ({
      page,
    }) => {
      const response = await page.goto("/search?page=99999&q=changelog");
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-out-of-range")).toBeVisible();
      await expect(page.getByTestId("search-error")).toHaveCount(0);
    });
  });

  test.describe("navigation", () => {
    test("a result link opens the document at the matching heading, which is visible", async ({
      page,
    }) => {
      await page.goto(DEPLOYMENT_URL);
      const operations = results(page).filter({ hasText: "docs/guides/operations.md" });
      await expect(operations.getByTestId("result-section")).toHaveText(
        "Section: Deployment checks",
      );
      await operations.getByTestId("result-link").click();
      await expect(page).toHaveURL(
        /\/acme\/search-lab\/docs\/guides\/operations#deployment-checks$/,
      );
      const heading = page.getByRole("heading", { level: 2, name: "Deployment checks" });
      await expect(heading).toBeVisible();
      await expect(heading).toBeInViewport();
    });

    test("a result without a matching heading opens the document", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await results(page).first().getByTestId("result-link").click();
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/deployment$/);
      await expect(page.getByRole("heading", { level: 1, name: "Deployment" })).toBeVisible();
    });

    test("the repository link opens the repository", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await results(page)
        .filter({ hasText: "docs/guides/setup.md" })
        .getByTestId("result-repo")
        .click();
      await expect(page).toHaveURL(/\/acme\/api-service$/);
    });

    test("works from the keyboard: search box, facets, results", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await page.getByRole("searchbox").focus();
      const visited: string[] = [];
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press("Tab");
        const id = await page.evaluate(
          () =>
            document.activeElement?.getAttribute("data-testid") ??
            document.activeElement?.tagName ??
            "",
        );
        visited.push(id);
        if (id === "result-link") break;
      }
      // search button, then the filters, then the first result
      expect(visited[0]).toBe("BUTTON");
      expect(visited).toContain("facet-option");
      expect(visited.at(-1)).toBe("result-link");
      await expect(page.getByTestId("result-link").first()).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/acme\/search-lab\/docs\/deployment$/);
    });

    test("a facet can be toggled with the keyboard", async ({ page }) => {
      await page.goto(DEPLOYMENT_URL);
      await option(page, "repo", "acme/api-service").focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search\?q=deployment&repo=acme%2Fapi-service$/);
      await expect(results(page)).toHaveCount(1);
      // focus is still inside the panel or on the page, never lost to nowhere
      expect(await page.evaluate(() => document.activeElement !== null)).toBe(true);
      await option(page, "repo", "acme/api-service").focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search\?q=deployment$/);
      await expect(results(page)).toHaveCount(10);
    });
  });

  test.describe("layout", () => {
    test("on a narrow screen the filters are a closed panel that opens", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(DEPLOYMENT_URL);
      const panel = page.getByTestId("facet-disclosure");
      await expect(panel).toBeVisible();
      await expect(panel).not.toHaveAttribute("open", "");
      await expect(group(page, "repo")).toBeHidden();
      await panel.locator(":scope > summary").click();
      await expect(group(page, "repo")).toBeVisible();
      // selecting a filter works from the opened panel
      await option(page, "repo", "acme/api-service").click();
      await expect(results(page)).toHaveCount(1);
      await expect(page.getByTestId("filter-count")).toHaveText("(1 selected)");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });

    test("on a wide screen the filters are open beside the results", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(DEPLOYMENT_URL);
      await expect(group(page, "repo")).toBeVisible();
      const panel = await page.getByTestId("facet-panel").boundingBox();
      const first = await results(page).first().boundingBox();
      expect(panel).not.toBeNull();
      expect(first).not.toBeNull();
      expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(first?.x ?? 0);
    });

    test("a very long unbroken query and filter value do not overflow", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      const long = "x".repeat(200);
      await page.goto(`/search?q=${long}&tag=${long}`);
      await expect(page.getByTestId("no-results")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`renders the narrow layout with the filter panel closed and open, ${theme} theme`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(`${DEPLOYMENT_URL}&repo=acme%2Fknowledge-base`);
      await expect(results(page)).toHaveCount(4);
      await page.screenshot({ path: `test-results/search-mobile-closed-${theme}.png` });
      await page.getByTestId("facet-disclosure").locator(":scope > summary").click();
      await expect(group(page, "repo")).toBeVisible();
      await page.screenshot({ path: `test-results/search-mobile-open-${theme}.png` });
    });

    test(`renders results and filters in the ${theme} theme`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      const errors = collectBrowserErrors(page);
      await page.goto(`${DEPLOYMENT_URL}&repo=acme%2Fknowledge-base`);
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
      await expect(results(page)).toHaveCount(4);
      const mark = page.locator("mark").first();
      await expect(mark).toBeVisible();
      // the highlight is set apart by color and weight, from tokens, in both themes
      const style = await mark.evaluate((el) => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, color: s.color, weight: s.fontWeight };
      });
      expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.background).not.toBe("rgb(255, 255, 0)");
      expect(Number(style.weight)).toBeGreaterThanOrEqual(600);
      await page.screenshot({ path: `test-results/search-results-${theme}.png`, fullPage: true });

      await page.goto("/search?q=zzzznothing&repo=acme%2Fapi-service");
      await expect(page.getByTestId("no-results")).toBeVisible();
      await page.screenshot({ path: `test-results/search-empty-${theme}.png`, fullPage: true });

      await page.goto("/search");
      await expect(page.getByTestId("no-query")).toBeVisible();
      await page.screenshot({ path: `test-results/search-noquery-${theme}.png`, fullPage: true });
      expect(errors).toEqual([]);
    });
  }
});

test.describe("search page, other database states", () => {
  test("an empty database gives an empty state, not an error", async ({ page }) => {
    test.skip(SKIP_DB, SKIP_DB_REASON);
    const response = await page.goto(`${stackUrl("empty")}/search?q=deployment`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("no-results")).toBeVisible();
    await expect(page.getByTestId("search-error")).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`an unreachable database shows the in-page error state, ${theme} theme`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      const response = await page.goto(
        `${stackUrl("unreachable")}/search?q=deployment&repo=acme%2Fapi`,
      );
      expect(response?.status()).toBe(200);
      const error = page.getByTestId("search-error");
      await expect(error).toBeVisible();
      await expect(error).toContainText("Search is unavailable");
      // the header, the search form and the retry link stay; the message names no host or user
      await expect(page.getByRole("search", { name: "Search documentation" })).toBeVisible();
      await expect(page.getByRole("searchbox")).toHaveValue("deployment");
      await expect(error.getByRole("link", { name: "Try again" })).toHaveAttribute(
        "href",
        "/search?q=deployment&repo=acme%2Fapi",
      );
      expect(await error.textContent()).not.toMatch(/postgres|127\.0\.0\.1|docmyrepos:|ECONN/i);
      await page.screenshot({ path: `test-results/search-error-${theme}.png`, fullPage: true });
    });
  }
});
