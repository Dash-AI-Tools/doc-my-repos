import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { THEME_TOKENS, contrastRatio, type ThemeName } from "../src/lib/theme-tokens";
import { stubAssets } from "./support/assets";
import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON, stackUrl, type StackName } from "./support/stack";

/**
 * Task 8.3: automated accessibility check (axe) and WCAG AA contrast in both themes.
 *
 * Every page is checked in light and dark, with the theme set the way the app stores it
 * (`docmyrepos-theme` in localStorage, read by the pre-paint script), plus the theme toggle
 * focused and, on the Mermaid fixture, the enlarge dialog open. Rules: WCAG 2.0/2.1 A and AA and
 * axe's best practices. No exclusions are needed.
 *
 * axe cannot judge every color (pseudo-elements, SVG internals, gradients), so the Shiki token
 * colors are also checked from computed styles against the `code-background` token, and the token
 * pairs are covered by src/lib/theme-tokens.test.ts.
 *
 * Every new page added in later task groups must be added to PAGES below.
 */

const KEY = "docmyrepos-theme";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

interface PageCase {
  readonly name: string;
  readonly path: string;
  /**
   * Which e2e server serves the page (see e2e/support/stack.ts). Default `fixtures` (the
   * playwright baseURL). `seeded` and `empty` need Postgres and skip under `E2E_SKIP_DB=1`.
   */
  readonly stack?: StackName;
  /** Runs before the navigation (route stubs). */
  readonly prepare?: (page: Page) => Promise<void>;
  /** Wait until the page is fully rendered. */
  readonly ready: (page: Page) => Promise<void>;
}

const PAGES: readonly PageCase[] = [
  {
    name: "home, repositories (seeded)",
    path: "/",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByTestId("repo-card").first()).toBeVisible();
      await expect(page.getByTestId("repo-sync-error")).toBeVisible();
      await expect(page.getByTestId("private-badge").first()).toBeVisible();
    },
  },
  {
    name: "home, nothing synced yet (empty database)",
    path: "/",
    stack: "empty",
    ready: async (page) => {
      await expect(page.getByTestId("empty-state")).toBeVisible();
    },
  },
  {
    name: "home, database error",
    path: "/",
    stack: "unreachable",
    ready: async (page) => {
      await expect(page.getByTestId("load-error")).toBeVisible();
    },
  },
  {
    name: "repo page, full (seeded)",
    path: "/acme/api-service",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("repo-header").getByRole("heading", { level: 1 })).toHaveText(
        "acme/api-service",
      );
      await expect(page.getByTestId("readme-body")).toBeVisible();
      await expect(page.getByTestId("owner-group").first()).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Documentation" })).toBeVisible();
    },
  },
  {
    name: "repo page, README with code, diagram and image (seeded)",
    path: "/acme/rich-readme",
    stack: "seeded",
    // The image goes through /api/asset, which would contact GitHub.
    prepare: async (page) => {
      await stubAssets(page);
    },
    ready: async (page) => {
      await expect(page.locator("pre.shiki").first()).toBeVisible();
      await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
        timeout: 30_000,
      });
    },
  },
  {
    name: "repo page, missing README and many code owners (seeded)",
    path: "/acme/no-readme",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("readme-empty")).toBeVisible();
      await expect(page.getByTestId("owner-more-patterns")).toBeVisible();
    },
  },
  {
    name: "repo page, no code owners (seeded)",
    path: "/acme/no-codeowners",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("code-owners-empty")).toBeVisible();
      await expect(page.getByTestId("readme-body")).toBeVisible();
    },
  },
  {
    name: "repo page, last sync failed (seeded)",
    path: "/acme/flaky-service",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("repo-sync-error")).toBeVisible();
      await expect(page.getByTestId("readme-body")).toBeVisible();
    },
  },
  {
    name: "repo page, private and OKF (seeded)",
    path: "/globex/handbook",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("private-badge")).toBeVisible();
      await expect(page.getByTestId("okf-badge")).toBeVisible();
    },
  },
  {
    name: "repo page, waiting for the first sync (seeded)",
    path: "/acme/brand-new",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("repo-pending")).toBeVisible();
    },
  },
  {
    name: "repo page, files not synced, details open (seeded)",
    path: "/acme/capped-docs",
    stack: "seeded",
    ready: async (page) => {
      const box = page.getByTestId("repo-sync-warnings");
      await expect(box).toBeVisible();
      await box.getByText("Show details").click();
      await expect(box.getByTestId("sync-warning").first()).toBeVisible();
      await expect(page.getByTestId("repo-last-run")).toBeVisible();
    },
  },
  {
    name: "sync status (seeded)",
    path: "/status",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Sync status" })).toBeVisible();
      await expect(page.getByTestId("status-last-run")).toBeVisible();
      await expect(page.getByTestId("status-repo-error").first()).toBeVisible();
      await expect(page.getByTestId("status-repo-warnings").first()).toBeVisible();
    },
  },
  {
    name: "sync status, nothing synced yet (empty database)",
    path: "/status",
    stack: "empty",
    ready: async (page) => {
      await expect(page.getByTestId("status-no-run")).toBeVisible();
      await expect(page.getByTestId("status-no-repos")).toBeVisible();
    },
  },
  {
    name: "sync status, database error",
    path: "/status",
    stack: "unreachable",
    ready: async (page) => {
      await expect(page.getByTestId("status-load-error")).toBeVisible();
    },
  },
  {
    name: "repo page, not found (seeded)",
    path: "/acme/does-not-exist",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("repo-not-found")).toBeVisible();
    },
  },
  {
    name: "repo page, no documentation files (seeded)",
    path: "/acme/empty-docs",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("docs-nav-empty")).toBeVisible();
    },
  },
  {
    name: "repo page, table of contents with folder summaries (seeded)",
    path: "/acme/doc-showcase",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("folder-summary").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Collapse all" })).toBeVisible();
    },
  },
  {
    name: "document page (seeded)",
    path: "/acme/api-service/docs/guides/setup",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
      await expect(page.locator("pre.shiki").first()).toBeVisible();
      await expect(page.getByTestId("doc-pager")).toBeVisible();
    },
  },
  {
    name: "document page, code, table, task list, footnote, image and diagram (seeded)",
    path: "/acme/doc-showcase/docs/guides/getting-started",
    stack: "seeded",
    prepare: async (page) => {
      await stubAssets(page);
    },
    ready: async (page) => {
      await expect(page.getByTestId("outline")).toBeVisible();
      await expect(page.locator("section.footnotes")).toBeVisible();
      await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
        timeout: 30_000,
      });
    },
  },
  {
    name: "document page, long outline with the current section marked (seeded)",
    path: "/acme/doc-showcase/docs/guides/long-outline#section-9",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("outline").locator('[aria-current="location"]')).toHaveText(
        "Section 9",
      );
    },
  },
  {
    name: "document page, folder index (seeded)",
    path: "/acme/doc-showcase/docs/guides/index",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Guides" })).toBeVisible();
      await expect(page.getByTestId("folder-summary").first()).toBeVisible();
    },
  },
  {
    name: "document page, not found (seeded)",
    path: "/acme/api-service/docs/does-not-exist",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("doc-not-found")).toBeVisible();
    },
  },
  {
    name: "repo page, OKF filters, nothing selected (seeded)",
    path: "/acme/knowledge-base",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-filters")).toBeVisible();
      await expect(page.getByTestId("okf-badge")).toBeVisible();
      await expect(page.getByTestId("okf-filter-chip").first()).toBeVisible();
    },
  },
  {
    name: "repo page, OKF filters selected and the tree narrowed (seeded)",
    path: "/acme/knowledge-base?status=active&type=Runbook&type=Table",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-filter-summary")).toHaveText("2 of 12 documents match");
      await expect(
        page.locator('[data-testid=okf-filter-chip][aria-current="true"]').first(),
      ).toBeVisible();
    },
  },
  {
    name: "repo page, OKF filters with no matching document (seeded)",
    path: "/acme/knowledge-base?type=Runbook&tag=glossary",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("docs-nav-no-match")).toBeVisible();
    },
  },
  {
    name: "document page, OKF filters in the sidebar (seeded)",
    path: "/acme/knowledge-base/docs/concepts/billing?type=Runbook",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
      await expect(page.getByTestId("okf-filter-summary")).toHaveText("3 of 12 documents match");
      // The page being read stays in the narrowed sidebar.
      await expect(page.getByTestId("docs-nav").locator('a[aria-current="page"]')).toHaveText(
        "Billing",
      );
    },
  },
  {
    name: "document page, OKF metadata card with every field (seeded)",
    path: "/acme/okf-showcase/docs/concepts/full-metadata",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-metadata")).toBeVisible();
      await expect(page.getByTestId("okf-row-sources")).toBeVisible();
      await expect(page.getByTestId("okf-other-fields")).toBeVisible();
    },
  },
  {
    name: "document page, OKF metadata card with only a type (seeded)",
    path: "/acme/okf-showcase/docs/concepts/type-only",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-type")).toHaveText("Note");
    },
  },
  {
    name: "document page, OKF unknown keys of every shape, hostile links as text (seeded)",
    path: "/acme/okf-showcase/docs/concepts/odd-keys",
    stack: "seeded",
    ready: async (page) => {
      await page.getByTestId("okf-other-fields").locator("summary").click();
      await expect(page.getByTestId("okf-other-list")).toBeVisible();
      await expect(page.getByTestId("okf-ref-link")).toHaveCount(1);
    },
  },
  {
    name: "document page, deprecated and stale notices stacked (seeded)",
    path: "/acme/okf-showcase/docs/concepts/stale-deprecated",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-notice-deprecated")).toBeVisible();
      await expect(page.getByTestId("okf-notice-stale")).toBeVisible();
    },
  },
  {
    name: "document page, draft notice (seeded)",
    path: "/acme/okf-showcase/docs/concepts/draft-metric",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-notice-draft")).toBeVisible();
    },
  },
  {
    name: "document page, stale_after in the future and dates that cannot be read (seeded)",
    path: "/acme/okf-showcase/docs/concepts/bad-dates",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("okf-row-stale-after")).toContainText("(not a valid date)");
    },
  },
  {
    name: "document page, log.md as a change log (seeded)",
    path: "/acme/okf-showcase/docs/log",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("change-log-badge")).toBeVisible();
      await expect(page.getByTestId("docs-tree-label")).toBeVisible();
    },
  },
  {
    name: "search, results with facets (seeded)",
    path: "/search?q=deployment",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("result")).toHaveCount(10);
      await expect(page.getByTestId("facet-group-type")).toBeVisible();
      await expect(page.getByTestId("private-badge").first()).toBeVisible();
      await expect(page.locator("mark").first()).toBeVisible();
    },
  },
  {
    name: "search, results with selected filters (seeded)",
    path: "/search?q=deployment&repo=acme%2Fknowledge-base&type=Runbook",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("result")).toHaveCount(1);
      await expect(page.getByTestId("active-filter")).toHaveCount(2);
      await expect(
        page.locator('[data-testid=facet-option][aria-current="true"]').first(),
      ).toBeAttached();
    },
  },
  {
    name: "search, second page (seeded)",
    path: "/search?page=2&q=changelog",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("result")).toHaveCount(5);
      await expect(page.getByTestId("pagination")).toBeVisible();
    },
  },
  {
    name: "search, hostile document title (seeded)",
    path: "/search?q=gateway",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("result")).toHaveCount(1);
    },
  },
  {
    name: "search, no results (seeded)",
    path: "/search?q=zzzznothing&repo=acme%2Fapi-service",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("no-results")).toBeVisible();
      await expect(page.getByTestId("active-filter")).toBeVisible();
    },
  },
  {
    name: "search, page past the end (seeded)",
    path: "/search?page=9&q=changelog",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("page-out-of-range")).toBeVisible();
    },
  },
  {
    name: "search, no query (seeded)",
    path: "/search",
    stack: "seeded",
    ready: async (page) => {
      await expect(page.getByTestId("no-query")).toBeVisible();
    },
  },
  {
    name: "search, database error",
    path: "/search?q=deployment",
    stack: "unreachable",
    ready: async (page) => {
      await expect(page.getByTestId("search-error")).toBeVisible();
    },
  },
  {
    name: "theme showcase",
    path: "/e2e/theme",
    ready: async (page) => {
      await expect(page.locator("pre.shiki").first()).toBeVisible();
      await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
        timeout: 30_000,
      });
    },
  },
  {
    name: "mermaid fixture",
    path: "/e2e/mermaid",
    ready: async (page) => {
      await expect(page.locator("pre.shiki").first()).toBeVisible();
      await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
        timeout: 30_000,
      });
    },
  },
];

function pageByName(name: string): PageCase {
  const found = PAGES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`No page case named ${name}`);
  return found;
}

/** Cases served by a database-backed server cannot run without Postgres. */
function needsDatabase(entry: PageCase): boolean {
  return entry.stack === "seeded" || entry.stack === "empty";
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" ; ")}`,
  );
}

async function open(page: Page, theme: ThemeName, entry: PageCase): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [KEY, theme],
  );
  await entry.prepare?.(page);
  await page.goto(entry.stack === undefined ? entry.path : `${stackUrl(entry.stack)}${entry.path}`);
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  await entry.ready(page);
}

function toHex(color: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (m === null) throw new Error(`Unexpected color ${color}`);
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe, ${theme} theme`, () => {
    // The stored choice wins over the OS preference; make the OS disagree to prove it.
    test.use({ colorScheme: theme === "dark" ? "light" : "dark" });

    for (const entry of PAGES) {
      test(`${entry.name}: no violations`, async ({ page }) => {
        test.skip(SKIP_DB && needsDatabase(entry), SKIP_DB_REASON);
        await open(page, theme, entry);
        expect(await violations(page)).toEqual([]);
      });

      test(`${entry.name}: no violations with the reading panel open`, async ({ page }) => {
        test.skip(SKIP_DB && needsDatabase(entry), SKIP_DB_REASON);
        await open(page, theme, entry);
        await page.getByRole("button", { name: "Text size and reading options" }).click();
        await page
          .getByRole("radiogroup", { name: "Theme" })
          .getByRole("radio", { checked: true })
          .focus();
        expect(await violations(page)).toEqual([]);
      });
    }

    test("mermaid fixture: no violations with the enlarge dialog open", async ({ page }) => {
      await open(page, theme, pageByName("mermaid fixture"));
      await page.getByRole("button", { name: "Enlarge diagram" }).click();
      const dialog = page.getByRole("dialog", { name: "Diagram" });
      await expect(dialog.locator("svg").first()).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test("search: no violations with a long facet list expanded", async ({ page }) => {
      test.skip(SKIP_DB, SKIP_DB_REASON);
      await open(page, theme, pageByName("search, results with facets (seeded)"));
      await page.getByTestId("facet-more-tag").locator("summary").click();
      await expect(page.getByTestId("facet-more-tag").getByTestId("facet-option")).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test("search: no violations on a narrow screen with the filter panel open", async ({
      page,
    }) => {
      test.skip(SKIP_DB, SKIP_DB_REASON);
      await page.setViewportSize({ width: 375, height: 800 });
      await open(page, theme, pageByName("search, results with selected filters (seeded)"));
      await page.getByTestId("facet-disclosure").locator(":scope > summary").click();
      await expect(page.getByTestId("facet-group-repo")).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test.describe("command palette open", () => {
      /** Opens the palette once the page is hydrated (the shortcut listener needs React). */
      async function openPalette(page: Page): Promise<void> {
        await expect(
          page.getByRole("button", { name: "Text size and reading options" }),
        ).toBeVisible();
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Quick search" })).toBeVisible();
        await expect(page.getByRole("combobox")).toBeFocused();
      }

      test("empty query (hints): no violations", async ({ page }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await open(page, theme, pageByName("home, repositories (seeded)"));
        await openPalette(page);
        await expect(page.getByTestId("palette-hint")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("results with one row active: no violations", async ({ page }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await open(page, theme, pageByName("home, repositories (seeded)"));
        await openPalette(page);
        await page.getByRole("combobox").pressSequentially("deployment");
        await expect(page.getByRole("option")).toHaveCount(8);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("[role=option] mark").first()).toBeVisible();
        await expect(page.getByTestId("palette-private-badge").first()).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("results on the search page, which has its own search form: no violations", async ({
        page,
      }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await open(page, theme, pageByName("search, results with facets (seeded)"));
        await openPalette(page);
        await page.getByRole("combobox").pressSequentially("gateway");
        await expect(page.getByRole("option")).toHaveCount(1);
        expect(await violations(page)).toEqual([]);
      });

      test("no results: no violations", async ({ page }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await open(page, theme, pageByName("home, repositories (seeded)"));
        await openPalette(page);
        await page.getByRole("combobox").pressSequentially("zzzznothing");
        await expect(page.getByTestId("palette-empty")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("search unavailable: no violations", async ({ page }) => {
        await open(page, theme, pageByName("home, database error"));
        await openPalette(page);
        await page.getByRole("combobox").pressSequentially("deployment");
        await expect(page.getByTestId("palette-error")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test("results on a phone, as a full-screen sheet: no violations", async ({ page }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await page.setViewportSize({ width: 375, height: 700 });
        await open(page, theme, pageByName("home, repositories (seeded)"));
        await page.getByTestId("palette-trigger").click();
        await expect(page.getByRole("dialog", { name: "Quick search" })).toBeVisible();
        await page.getByRole("combobox").pressSequentially("deployment");
        await expect(page.getByRole("option")).toHaveCount(8);
        await page.keyboard.press("ArrowDown");
        expect(await violations(page)).toEqual([]);
      });

      test("the header trigger focused: no violations", async ({ page }) => {
        test.skip(SKIP_DB, SKIP_DB_REASON);
        await open(page, theme, pageByName("home, repositories (seeded)"));
        await page.getByTestId("palette-trigger").focus();
        expect(await violations(page)).toEqual([]);
      });
    });

    test.describe("account menu open", () => {
      /** The menu sits in the header of every page; the fixture page needs no database (4.3). */
      const MENU_PAGE: PageCase = {
        name: "theme showcase",
        path: "/e2e/theme",
        ready: async (page) => {
          // Hydrated: the trigger is a client component.
          await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
        },
      };

      async function openMenu(page: Page): Promise<void> {
        await open(page, theme, MENU_PAGE);
        await page.getByTestId("account-menu-trigger").click();
        await expect(page.getByTestId("account-menu")).toBeVisible();
        await expect(page.getByRole("link", { name: "Branding" })).toBeVisible();
      }

      test("no violations", async ({ page }) => {
        await openMenu(page);
        expect(await violations(page)).toEqual([]);
      });

      test("on a phone, the panel stays inside the viewport without horizontal scroll", async ({
        page,
      }) => {
        await page.setViewportSize({ width: 375, height: 800 });
        await openMenu(page);
        expect(await violations(page)).toEqual([]);
        const box = await page.getByTestId("account-menu").boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375 + 1);
        // The header wraps at this width; the open panel must not widen the document either.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1);
      });
    });

    const READERS: readonly { label: string; page: PageCase }[] = [
      {
        label: "document page",
        page: {
          name: "document page, long outline (seeded)",
          path: "/acme/doc-showcase/docs/guides/long-outline",
          stack: "seeded",
          ready: async (page) => {
            await expect(page.getByTestId("doc-article")).toBeVisible();
            // hydrated: the bar is shown on a small screen, the column on a large one
            await expect(page.locator(".doc-reader")).toHaveAttribute("data-enhanced", "true");
          },
        },
      },
      {
        label: "repository page",
        page: {
          name: "repository page, README with headings (seeded)",
          path: "/acme/api-service",
          stack: "seeded",
          ready: async (page) => {
            await expect(page.getByTestId("readme-section")).toBeVisible();
            await expect(page.locator(".doc-reader")).toHaveAttribute("data-enhanced", "true");
          },
        },
      },
    ];

    for (const { label, page: READER } of READERS) {
      test.describe(`${label} reader layout`, () => {
        test("three columns at 1440: no violations", async ({ page }) => {
          test.skip(SKIP_DB, SKIP_DB_REASON);
          await page.setViewportSize({ width: 1440, height: 900 });
          await open(page, theme, READER);
          await expect(page.getByTestId("outline")).toBeVisible();
          expect(await violations(page)).toEqual([]);
        });

        test("two columns at 1100 with the headings dropdown open: no violations", async ({
          page,
        }) => {
          test.skip(SKIP_DB, SKIP_DB_REASON);
          await page.setViewportSize({ width: 1100, height: 900 });
          await open(page, theme, READER);
          expect(await violations(page)).toEqual([]);
          await page.getByTestId("outline-menu").getByRole("button").click();
          await expect(page.getByTestId("outline-menu-list")).toBeVisible();
          expect(await violations(page)).toEqual([]);
        });

        test("one column at 375: no violations, then with the panel open", async ({ page }) => {
          test.skip(SKIP_DB, SKIP_DB_REASON);
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.setViewportSize({ width: 375, height: 800 });
          await open(page, theme, READER);
          expect(await violations(page)).toEqual([]);
          await page.getByTestId("doc-nav-toggle").click();
          await expect(page.getByRole("dialog", { name: "Documentation menu" })).toBeVisible();
          expect(await violations(page)).toEqual([]);
        });

        test("one column at 375 with the headings dropdown open: no violations", async ({
          page,
        }) => {
          test.skip(SKIP_DB, SKIP_DB_REASON);
          await page.setViewportSize({ width: 375, height: 800 });
          await open(page, theme, READER);
          await page.getByTestId("outline-menu").getByRole("button").click();
          await expect(page.getByTestId("outline-menu-list")).toBeVisible();
          expect(await violations(page)).toEqual([]);
        });
      });
    }

    test("Shiki token colors meet AA on the code background", async ({ page }) => {
      await open(page, theme, pageByName("theme showcase"));
      const background = THEME_TOKENS[theme]["code-background"];
      const colors = await page
        .locator("pre.shiki span")
        .evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
      expect(colors.length).toBeGreaterThan(1);
      for (const color of colors) {
        expect(
          contrastRatio(toHex(color), background),
          `${color} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}
