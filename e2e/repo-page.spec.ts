import { expect, test, type Locator, type Page } from "@playwright/test";

import { THEME_TOKENS, type ThemeName } from "../src/lib/theme-tokens";
import { stubAssets } from "./support/assets";
import { SEED_REPOS, SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Tasks 9.3 to 9.5: the repository page `/<owner>/<repo>` in a real browser (Chromium) against the
 * seeded database (e2e/support/seed-data.ts).
 *
 * - 9.3 shell: header (GitHub link, last synced, badges, sync state), not-found handling (HTTP 404
 *   for unknown, malformed and reserved addresses), the Documentation navigation slot that task
 *   9.6 fills.
 * - 9.4 README: rendered by the real pipeline (headings, highlighted code, Mermaid, rewritten and
 *   broken links, proxied image), empty state without a README.
 * - 9.5 code owners: grouping, profile and team links, many patterns, empty state.
 *
 * Screenshots go to `test-results/` (light and dark) for inspection.
 */

const KEY = "docmyrepos-theme";

function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

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

const path = (r: { owner: string; name: string }) => `/${r.owner}/${r.name}`;

function owners(page: Page): Locator {
  return page.getByTestId("owner-group");
}

function owner(page: Page, key: string): Locator {
  return page.locator(`[data-testid=owner-group][data-owner="${key}"]`);
}

function patterns(group: Locator): Promise<string[]> {
  return group.locator("li code").allTextContents();
}

test.describe("repository page, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  test.describe("full repository (README, CODEOWNERS, docs)", () => {
    test("shows the header, README, documentation slot and code owners, with no browser errors", async ({
      page,
    }) => {
      const errors = collectBrowserErrors(page);
      const response = await page.goto(path(SEEDED.full));
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle("acme/api-service · DocMyRepos");

      const header = page.getByTestId("repo-header");
      await expect(header.getByRole("heading", { level: 1 })).toHaveText("acme/api-service");
      await expect(header.getByTestId("repo-description")).toHaveText(
        "The public REST API of the platform.",
      );
      const github = header.getByRole("link", { name: "View on GitHub" });
      await expect(github).toHaveAttribute("href", "https://github.com/acme/api-service");
      await expect(github).toHaveAttribute("rel", "noopener noreferrer");
      const time = header.locator("time");
      await expect(time).toHaveAttribute("datetime", "2026-03-14T09:30:00.000Z");
      await expect(time).toHaveAttribute("title", "14 Mar 2026, 09:30 UTC");
      await expect(time).toContainText(/ago|yesterday|last (month|year)/);
      await expect(header.getByTestId("repo-meta")).toContainText("4 documents");
      await expect(header.getByTestId("private-badge")).toHaveCount(0);
      await expect(header.getByTestId("okf-badge")).toHaveCount(0);
      await expect(header.getByTestId("repo-sync-error")).toHaveCount(0);
      await expect(header.getByTestId("repo-pending")).toHaveCount(0);

      await expect(page.getByRole("heading", { level: 2, name: "README" })).toBeVisible();
      await expect(page.getByTestId("readme-empty")).toHaveCount(0);
      await expect(
        page.getByTestId("readme-body").getByRole("heading", { level: 2, name: "Quick start" }),
      ).toBeVisible();

      const nav = page.getByRole("navigation", { name: "Documentation" });
      await expect(nav.getByRole("heading", { level: 2, name: "Documentation" })).toBeVisible();
      await expect(nav).toContainText("4 documents");
      await expect(page.getByRole("heading", { level: 2, name: /^Code owners/ })).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("the breadcrumb leads home", async ({ page }) => {
      await page.goto(path(SEEDED.full));
      const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(crumbs.locator("[aria-current=page]")).toHaveText("acme/api-service");
      await crumbs.getByRole("link", { name: "Home" }).click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Documentation portal");
    });

    test("a card on the home page opens the repository page", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "acme/api-service", exact: true }).click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
      await expect(page.getByTestId("repo-header").getByRole("heading", { level: 1 })).toHaveText(
        "acme/api-service",
      );
    });

    test("renders the README: headings, and a relative link to a synced doc rewritten to the portal", async ({
      page,
    }) => {
      await page.goto(path(SEEDED.full));
      const body = page.getByTestId("readme-body");
      await expect(body.getByRole("heading", { level: 1, name: "api-service" })).toBeVisible();
      const link = body.getByRole("link", { name: "setup guide" });
      await expect(link).toHaveAttribute("href", "/acme/api-service/docs/guides/setup");
    });

    test("groups the code owners as in the spec: @alice covers * and the team covers /docs/", async ({
      page,
    }) => {
      await page.goto(path(SEEDED.full));
      await expect(owners(page)).toHaveCount(2);
      const alice = owner(page, "@alice");
      await expect(alice.getByRole("link", { name: "@alice" })).toHaveAttribute(
        "href",
        "https://github.com/alice",
      );
      await expect(alice).toContainText("User");
      expect(await patterns(alice)).toEqual(["*"]);
      const team = owner(page, "@acme/docs-team");
      await expect(team.getByRole("link", { name: "@acme/docs-team" })).toHaveAttribute(
        "href",
        "https://github.com/orgs/acme/teams/docs-team",
      );
      await expect(team).toContainText("Team");
      expect(await patterns(team)).toEqual(["/docs/"]);
      await expect(page.getByTestId("code-owners-empty")).toHaveCount(0);
      // order of first appearance in the file
      expect(
        await owners(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-owner"))),
      ).toEqual(["@alice", "@acme/docs-team"]);
    });

    test("is keyboard operable: breadcrumb, GitHub link, then the owner links, with a focus ring", async ({
      page,
    }) => {
      await page.goto(path(SEEDED.full));
      const home = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link");
      await home.focus();
      await page.keyboard.press("Tab");
      const github = page.getByRole("link", { name: "View on GitHub" });
      await expect(github).toBeFocused();
      const ring = await github.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth };
      });
      expect(ring).toEqual({ style: "solid", width: "2px" });

      const alice = page.getByRole("link", { name: "@alice" });
      for (
        let i = 0;
        i < 40 && !(await alice.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(alice).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "@acme/docs-team" })).toBeFocused();
    });

    test("puts the sidebar next to the README on wide screens and below it on phones", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path(SEEDED.full));
      const readme = await page.getByTestId("readme-section").boundingBox();
      const nav = await page.getByTestId("docs-nav").boundingBox();
      const panel = await page.getByTestId("code-owners").boundingBox();
      if (!readme || !nav || !panel) throw new Error("missing layout boxes");
      expect(nav.x).toBeGreaterThan(readme.x + readme.width - 1);
      expect(panel.x).toBeGreaterThan(readme.x + readme.width - 1);
      expect(panel.y).toBeGreaterThan(nav.y);

      await page.setViewportSize({ width: 375, height: 800 });
      const phoneReadme = await page.getByTestId("readme-section").boundingBox();
      const phoneNav = await page.getByTestId("docs-nav").boundingBox();
      if (!phoneReadme || !phoneNav) throw new Error("missing layout boxes");
      expect(phoneNav.y).toBeGreaterThan(phoneReadme.y + phoneReadme.height - 1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });

    test("redirects a differently cased address to the stored spelling", async ({ page }) => {
      const response = await page.goto("/ACME/Api-Service");
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(`${stackUrl("seeded")}/acme/api-service`);
      await expect(page.getByTestId("repo-header").getByRole("heading", { level: 1 })).toHaveText(
        "acme/api-service",
      );
    });
  });

  test.describe("README rendered by the Markdown pipeline (acme/rich-readme)", () => {
    test("highlights code, draws the Mermaid diagram and adds copy buttons", async ({ page }) => {
      await stubAssets(page);
      const errors = collectBrowserErrors(page);
      await page.goto(path(SEEDED.richReadme));
      const body = page.getByTestId("readme-body");
      const code = body.locator("pre.shiki");
      await expect(code).toHaveCount(1);
      await expect(code.locator("span[style*='--shiki']").first()).toBeVisible();
      // Shiki token colours come from CSS variables, so the code is coloured, not plain
      const colours = await code
        .locator("span[style*='--shiki']")
        .evaluateAll((els) => new Set(els.map((el) => getComputedStyle(el).color)).size);
      expect(colours).toBeGreaterThan(1);
      await expect(body.getByRole("button", { name: "Copy code" })).toHaveCount(1);

      await expect(body.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(body.locator("pre.dmr-mermaid")).toBeHidden();
      expect(errors).toEqual([]);
    });

    test("rewrites the relative doc link, marks the broken link and links other files to GitHub", async ({
      page,
    }) => {
      await stubAssets(page);
      await page.goto(path(SEEDED.richReadme));
      const body = page.getByTestId("readme-body");
      await expect(body.getByRole("link", { name: "guide", exact: true })).toHaveAttribute(
        "href",
        "/acme/rich-readme/docs/guide",
      );
      const broken = body.locator("a.dmr-broken-link");
      await expect(broken).toHaveText("missing page");
      await expect(broken).not.toHaveAttribute("href", /.+/);
      await expect(broken).toHaveAttribute("title", /Broken link/);
      const source = body.getByRole("link", { name: "source file" });
      await expect(source).toHaveAttribute(
        "href",
        "https://github.com/acme/rich-readme/blob/main/src/index.ts",
      );
      await expect(source).toHaveAttribute("rel", /noopener/);
    });

    test("serves the image through the asset proxy URL", async ({ page }) => {
      const requested = await stubAssets(page);
      await page.goto(path(SEEDED.richReadme));
      const img = page
        .getByTestId("readme-body")
        .getByRole("img", { name: "Architecture overview" });
      await expect(img).toHaveAttribute(
        "src",
        "/api/asset/acme/rich-readme/docs/assets/architecture.png",
      );
      await img.scrollIntoViewIfNeeded();
      await expect
        .poll(() => requested)
        .toEqual(["/api/asset/acme/rich-readme/docs/assets/architecture.png"]);
      await expect
        .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    });

    test("shows the diagram source and the code without JavaScript", async ({ browser }) => {
      const context = await browser.newContext({
        baseURL: stackUrl("seeded"),
        javaScriptEnabled: false,
      });
      await stubAssets(context);
      const page = await context.newPage();
      await page.goto(path(SEEDED.richReadme));
      const body = page.getByTestId("readme-body");
      await expect(body.locator("pre.dmr-mermaid")).toBeVisible();
      await expect(body.locator("pre.dmr-mermaid")).toContainText("graph TD");
      await expect(body.getByRole("heading", { level: 1, name: "rich-readme" })).toBeVisible();
      await context.close();
    });
  });

  test.describe("repository without a README (acme/no-readme)", () => {
    test("shows the README empty state while the rest still renders", async ({ page }) => {
      const response = await page.goto(path(SEEDED.noReadme));
      expect(response?.status()).toBe(200);
      const empty = page.getByTestId("readme-empty");
      await expect(empty).toContainText("No README found");
      await expect(empty).toContainText("README.md");
      await expect(page.getByRole("heading", { level: 2, name: "README" })).toBeVisible();
      await expect(page.getByTestId("readme-body")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("acme/no-readme");
      await expect(page.getByRole("navigation", { name: "Documentation" })).toContainText(
        "1 document",
      );
      await expect(owners(page).first()).toBeVisible();
    });

    test("groups owners case-insensitively, in file order, and omits patterns without an owner", async ({
      page,
    }) => {
      await page.goto(path(SEEDED.noReadme));
      expect(
        await owners(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-owner"))),
      ).toEqual(["@bob", "@acme/platform", "security@acme.example", "@carol"]);
      await expect(page.getByRole("heading", { level: 2, name: /^Code owners/ })).toContainText(
        "(4)",
      );
      // `@Bob` and `@bob` are one owner, shown as first written
      const bob = owner(page, "@bob");
      await expect(bob.getByRole("link", { name: "@bob", exact: true })).toBeVisible();
      expect(await patterns(bob)).toEqual(["*", "/docs/"]);
      await expect(bob).toContainText("2 patterns");
      // `@Acme/Platform` keeps its spelling, and links to the team
      await expect(owner(page, "@acme/platform").getByRole("link")).toHaveText("@Acme/Platform");
      await expect(owner(page, "@acme/platform").getByRole("link")).toHaveAttribute(
        "href",
        "https://github.com/orgs/Acme/teams/Platform",
      );
      // an e-mail owner links with mailto: and is labelled
      const mail = owner(page, "security@acme.example");
      await expect(mail.getByRole("link")).toHaveAttribute("href", "mailto:security@acme.example");
      await expect(mail).toContainText("Email");
      expect(await patterns(mail)).toEqual(["/SECURITY.md"]);
      await expect(page.getByTestId("code-owners")).not.toContainText("/vendor/");
    });

    test("folds a long list of patterns into a details element that opens", async ({ page }) => {
      await page.goto(path(SEEDED.noReadme));
      const carol = owner(page, "@carol");
      await expect(carol).toContainText("11 patterns");
      const more = carol.getByTestId("owner-more-patterns");
      await expect(more.locator("summary")).toHaveText("Show 3 more patterns");
      const inside = more.locator("code").first();
      await expect(inside).toBeHidden();
      // the first eight are visible
      await expect(carol.locator("> ul > li code")).toHaveCount(8);
      await more.locator("summary").click();
      await expect(inside).toBeVisible();
      await expect(more.locator("code")).toHaveCount(3);
      // keyboard: the summary is focusable and Enter toggles it
      await more.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(inside).toBeHidden();
    });

    test("wraps a very long pattern instead of overflowing, on a phone", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(path(SEEDED.noReadme));
      await owner(page, "@carol").getByTestId("owner-more-patterns").locator("summary").click();
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panel: (() => {
          const el = document.querySelector("[data-testid=code-owners]") as HTMLElement;
          return el.scrollWidth - el.clientWidth;
        })(),
      }));
      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(overflow.panel).toBeLessThanOrEqual(0);
    });
  });

  test.describe("repository without CODEOWNERS (acme/no-codeowners)", () => {
    test("states that no code owners are defined, and still shows the README", async ({ page }) => {
      const response = await page.goto(path(SEEDED.noCodeowners));
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("code-owners-empty")).toContainText(
        "No code owners are defined",
      );
      await expect(owners(page)).toHaveCount(0);
      await expect(
        page.getByTestId("readme-body").getByRole("heading", { level: 1, name: "no-codeowners" }),
      ).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Documentation" })).toBeVisible();
    });
  });

  test.describe("sync states and badges", () => {
    test("a repository whose last sync failed shows the error and its stored content", async ({
      page,
    }) => {
      const response = await page.goto(path(SEEDED.errored));
      expect(response?.status()).toBe(200);
      const box = page.getByTestId("repo-sync-error");
      await expect(box).toBeVisible();
      await expect(box).toHaveAttribute("role", "status");
      await expect(box).toContainText("Last sync failed");
      await expect(box).toContainText("GitHub rate limit exhausted; retry later");
      await expect(box).toContainText("Showing previously synced content.");
      // stored README, docs count and the last successful sync time
      await expect(
        page.getByTestId("readme-body").getByRole("heading", { name: "flaky-service" }),
      ).toBeVisible();
      await expect(page.getByTestId("docs-nav")).toContainText("2 documents");
      await expect(page.getByTestId("repo-header").locator("time")).toHaveAttribute(
        "datetime",
        "2026-02-01T08:15:00.000Z",
      );
    });

    test("a repository that was never synced explains that, without claiming it has no README", async ({
      page,
    }) => {
      const response = await page.goto(path(SEEDED.pending));
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("repo-pending")).toContainText("Waiting for the first sync");
      await expect(page.getByTestId("repo-meta")).toContainText("Not synced yet");
      await expect(page.getByTestId("readme-empty")).toContainText("after the first sync");
      await expect(page.getByTestId("code-owners-empty")).toContainText("after the first sync");
      await expect(page.getByTestId("docs-nav")).toContainText("No documents");
      await expect(page.getByText("No README found")).toHaveCount(0);
    });

    test("shows the Private badge on the header of a private repository only", async ({ page }) => {
      await page.goto(path(SEEDED.private));
      await expect(page.getByTestId("repo-header").getByTestId("private-badge")).toHaveText(
        "Private",
      );
      await page.goto(path(SEEDED.full));
      await expect(page.getByTestId("private-badge")).toHaveCount(0);
    });

    test("shows the OKF badge, with the version when declared", async ({ page }) => {
      await page.goto(path(SEEDED.okf));
      await expect(page.getByTestId("repo-header").getByTestId("okf-badge")).toHaveText("OKF v0.2");
      await expect(page.getByTestId("private-badge")).toHaveCount(0);
      await page.goto(path(SEEDED.privateOkf));
      await expect(page.getByTestId("okf-badge")).toHaveText("OKF");
      await expect(page.getByTestId("private-badge")).toBeVisible();
    });

    test("shows a long name and description without overflowing", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(path(SEEDED.long));
      await expect(page.getByRole("heading", { level: 1 })).toContainText("a-repository-with");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      // markup in the description is text, not elements
      await expect(page.getByTestId("repo-header").locator("img, b")).toHaveCount(0);
    });
  });

  test.describe("unknown and malformed addresses", () => {
    test("an unknown repository is a 404 page with a link home", async ({ page }) => {
      const errors = collectBrowserErrors(page);
      const response = await page.goto("/acme/does-not-exist");
      expect(response?.status()).toBe(404);
      const panel = page.getByTestId("repo-not-found");
      await expect(
        panel.getByRole("heading", { level: 1, name: "Repository not found" }),
      ).toBeVisible();
      await expect(page).toHaveTitle(/Repository not found/);
      // the layout stays
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
      await expect(page.getByTestId("repo-header")).toHaveCount(0);
      // the page says the same for an unknown owner
      expect((await page.goto("/nobody/does-not-exist"))?.status()).toBe(404);
      await page.goto("/acme/does-not-exist");
      await panel.getByRole("link", { name: "Back to the home page" }).click();
      await expect(page).toHaveURL(`${stackUrl("seeded")}/`);
      // Chromium logs the 404 document itself as a console error; nothing else may be logged
      expect(errors.filter((e) => !/404/.test(e))).toEqual([]);
    });

    // Not listed: a malformed percent escape (`/acme/%E0%A4%A`) is answered with a bare 500 by
    // Next.js itself, before any page code runs, on every route (`/api/%E0%A4%A` too).
    test("addresses that cannot name a repository are a plain 404, never a server error", async ({
      request,
    }) => {
      for (const url of [
        "/acme/a%20b",
        "/acme/a%2Fb",
        "/acme/%00",
        "/acme/%F0%9F%98%80",
        "/-acme/x",
        "/ac.me/x",
        "/acme/x'%20OR%20'1'='1",
        `/acme/${"x".repeat(500)}`,
        `/${"o".repeat(500)}/x`,
      ]) {
        const response = await request.get(url);
        expect(response.status(), url).toBe(404);
        const text = await response.text();
        expect(text, url).toContain("Repository not found");
        expect(text, url).not.toMatch(/postgres|ECONNREFUSED|stack|Internal Server Error/i);
      }
    });

    test("names the app owns are not repositories, whatever the case", async ({ request }) => {
      for (const url of [
        "/search/x",
        "/Search/x",
        "/api/nothing",
        "/API/nothing",
        "/e2e/nothing",
      ]) {
        const response = await request.get(url);
        expect(response.status(), url).toBe(404);
      }
      // the real routes still work
      expect((await request.get("/")).status()).toBe(200);
      expect((await request.get("/api/sync")).status()).toBe(405);
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        // The stored choice wins over the OS preference; make the OS disagree to prove it.
        await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
        await setTheme(page, theme);
      });

      test("renders the full repository page with the tokens", async ({ page }, testInfo) => {
        await page.goto(path(SEEDED.full));
        await expect(page.locator("html")).toHaveClass(
          theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
        );
        const tokens = THEME_TOKENS[theme];
        const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(await bg(page.getByTestId("readme-section"))).toBe(rgb(tokens.card));
        expect(await bg(page.getByTestId("code-owners"))).toBe(rgb(tokens.card));
        expect(await bg(page.getByTestId("docs-nav"))).toBe(rgb(tokens.card));
        await page.screenshot({
          path: testInfo.outputPath(`repo-full-${theme}.png`),
          fullPage: true,
        });
      });

      test("renders the Mermaid README page", async ({ page }, testInfo) => {
        await stubAssets(page);
        await page.goto(path(SEEDED.richReadme));
        await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
          timeout: 30_000,
        });
        await page.screenshot({
          path: testInfo.outputPath(`repo-rich-${theme}.png`),
          fullPage: true,
        });
      });

      test("renders owners with many patterns and the README empty state", async ({
        page,
      }, testInfo) => {
        await page.goto(path(SEEDED.noReadme));
        const tokens = THEME_TOKENS[theme];
        await owner(page, "@carol").getByTestId("owner-more-patterns").locator("summary").click();
        const code = owner(page, "@bob").locator("code").first();
        expect(await code.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
          rgb(tokens["code-background"]),
        );
        await page.screenshot({
          path: testInfo.outputPath(`repo-no-readme-${theme}.png`),
          fullPage: true,
        });
      });

      test("renders the error, private and pending headers", async ({ page }, testInfo) => {
        const tokens = THEME_TOKENS[theme];
        const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
        const fg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);

        await page.goto(path(SEEDED.errored));
        const failed = page.getByTestId("repo-sync-error");
        expect(await bg(failed)).toBe(rgb(tokens["destructive-muted"]));
        expect(await fg(failed)).toBe(rgb(tokens["destructive-muted-foreground"]));
        await page.screenshot({
          path: testInfo.outputPath(`repo-errored-${theme}.png`),
          fullPage: true,
        });

        await page.goto(path(SEEDED.private));
        const badge = page.getByTestId("private-badge");
        expect(await bg(badge)).toBe(rgb(tokens["private-badge"]));
        expect(await fg(badge)).toBe(rgb(tokens["private-badge-foreground"]));

        await page.goto(path(SEEDED.pending));
        const pending = page.getByTestId("repo-pending");
        expect(await bg(pending)).toBe(rgb(tokens.warning));
        expect(await fg(pending)).toBe(rgb(tokens["warning-foreground"]));
        await page.screenshot({
          path: testInfo.outputPath(`repo-pending-${theme}.png`),
          fullPage: true,
        });
      });

      test("renders the not-found page", async ({ page }, testInfo) => {
        await page.goto("/acme/does-not-exist");
        await expect(page.getByTestId("repo-not-found")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`repo-not-found-${theme}.png`),
          fullPage: true,
        });
      });
    });
  }

  test("the seed holds the repositories this spec relies on", () => {
    const names = SEED_REPOS.map((r) => `${r.owner}/${r.name}`);
    for (const ref of Object.values(SEEDED)) expect(names).toContain(`${ref.owner}/${ref.name}`);
    expect(SEED_REPOS.find((r) => r.name === "no-readme")?.readme).toBeUndefined();
    expect(SEED_REPOS.find((r) => r.name === "no-codeowners")?.codeowners).toBeUndefined();
  });
});
