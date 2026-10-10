import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { THEME_TOKENS, contrastRatio, type ThemeName } from "../src/lib/theme-tokens";

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
  /** Wait until the page is fully rendered. */
  readonly ready: (page: Page) => Promise<void>;
}

const PAGES: readonly PageCase[] = [
  {
    name: "home",
    path: "/",
    ready: async (page) => {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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
  await page.goto(entry.path);
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
        await open(page, theme, entry);
        expect(await violations(page)).toEqual([]);
      });

      test(`${entry.name}: no violations with the theme toggle focused`, async ({ page }) => {
        await open(page, theme, entry);
        await page
          .getByRole("radiogroup", { name: "Theme" })
          .getByRole("radio", { checked: true })
          .focus();
        expect(await violations(page)).toEqual([]);
      });
    }

    test("mermaid fixture: no violations with the enlarge dialog open", async ({ page }) => {
      await open(page, theme, PAGES[2] as PageCase);
      await page.getByRole("button", { name: "Enlarge diagram" }).click();
      const dialog = page.getByRole("dialog", { name: "Diagram" });
      await expect(dialog.locator("svg").first()).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test("Shiki token colors meet AA on the code background", async ({ page }) => {
      await open(page, theme, PAGES[1] as PageCase);
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
