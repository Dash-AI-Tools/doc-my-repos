import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { THEME_TOKENS, contrastRatio, type ThemeName } from "../src/lib/theme-tokens";
import { stubAssets } from "./support/assets";
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

      test(`${entry.name}: no violations with the theme toggle focused`, async ({ page }) => {
        test.skip(SKIP_DB && needsDatabase(entry), SKIP_DB_REASON);
        await open(page, theme, entry);
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
