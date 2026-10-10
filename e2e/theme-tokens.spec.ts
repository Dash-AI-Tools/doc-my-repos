import { expect, test, type Page } from "@playwright/test";

import {
  THEME_TOKENS,
  TOKEN_NAMES,
  contrastRatio,
  type ThemeName,
  type TokenName,
} from "../src/lib/theme-tokens";

/**
 * Task 8.1: both palettes render. Loads the token showcase (`/e2e/theme`,
 * src/app/e2e/theme/page.tsx) in light and dark, and checks the computed colors against the token
 * constants. Screenshots go to `test-results/theme-*.png` for visual inspection. The theme is
 * forced by the `dark` class on <html> (set before any script runs) together with the matching
 * `prefers-color-scheme`, so the spec does not depend on how the theme provider picks the theme.
 */

const PAGE = "/e2e/theme";

interface AxeBuilderLike {
  new (options: { page: Page }): {
    withRules(rules: string[]): { analyze(): Promise<{ violations: unknown[] }> };
  };
}

/** axe arrives with task 8.3; until then the check is skipped instead of failing. */
async function loadAxe(): Promise<AxeBuilderLike | null> {
  try {
    const name = "@axe-core/playwright";
    const mod = (await import(name)) as { default: AxeBuilderLike };
    return mod.default;
  } catch {
    return null;
  }
}

function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

function toHex(color: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (m === null) throw new Error(`Unexpected color ${color}`);
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}

async function style(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

async function open(page: Page, theme: ThemeName): Promise<void> {
  if (theme === "dark") {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
  }
  await page.goto(PAGE);
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  // Highlighted code and a rendered diagram are part of what is being checked.
  await expect(page.locator("pre.shiki").first()).toBeVisible();
  await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} palette`, () => {
    test.use({ colorScheme: theme });
    const tokens = THEME_TOKENS[theme];

    test.beforeEach(async ({ page }) => {
      await open(page, theme);
    });

    test("page colors match the tokens", async ({ page }) => {
      const background = await style(page, "body", "background-color");
      const foreground = await style(page, "body", "color");
      expect(background).toBe(rgb(tokens.background));
      expect(foreground).toBe(rgb(tokens.foreground));
      expect(await style(page, "html", "color-scheme")).toBe(theme);
    });

    test("every swatch shows its token", async ({ page }) => {
      for (const name of TOKEN_NAMES) {
        const swatch = `[data-swatch="${name}"]`;
        expect(await style(page, swatch, "background-color"), name).toBe(rgb(tokens[name]));
      }
    });

    test("components use the tokens", async ({ page }) => {
      const badges: readonly [string, TokenName, TokenName][] = [
        ["private", "private-badge-foreground", "private-badge"],
        ["OKF", "okf-badge-foreground", "okf-badge"],
        ["synced", "success-foreground", "success"],
        ["syncing", "warning-foreground", "warning"],
        ["error", "destructive-foreground", "destructive"],
      ];
      for (const [text, fg, bg] of badges) {
        const badge = page.getByTestId("badges").getByText(text, { exact: true });
        const color = await badge.evaluate((el) => getComputedStyle(el).color);
        const fill = await badge.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(color, `${text} text`).toBe(rgb(tokens[fg]));
        expect(fill, `${text} fill`).toBe(rgb(tokens[bg]));
        expect(contrastRatio(toHex(color), toHex(fill))).toBeGreaterThanOrEqual(4.5);
      }

      const link = page.locator('[data-testid="fixture-doc"] a[href="/e2e/theme"]');
      expect(await link.evaluate((el) => getComputedStyle(el).color)).toBe(rgb(tokens.link));
      expect(await style(page, "pre.shiki", "background-color")).toBe(
        rgb(tokens["code-background"]),
      );
      expect(await style(page, ".markdown-body :not(pre) > code", "color")).toBe(
        rgb(tokens["code-foreground"]),
      );
      expect(await style(page, ".markdown-body th", "background-color")).toBe(rgb(tokens.muted));
      expect(await style(page, ".markdown-body blockquote", "color")).toBe(
        rgb(tokens["muted-foreground"]),
      );
    });

    test("code tokens follow the theme", async ({ page }) => {
      const colors = await page
        .locator("pre.shiki span span")
        .evaluateAll((els) => new Set(els.map((el) => getComputedStyle(el).color)).size);
      expect(colors).toBeGreaterThan(1);
    });

    test("focus ring uses the ring token", async ({ page }) => {
      await page.getByRole("button", { name: "Primary" }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const button = page.getByRole("button", { name: "Primary" });
      await expect(button).toBeFocused();
      expect(await button.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(
        rgb(tokens.ring),
      );
    });

    test("screenshot", async ({ page }) => {
      await page.screenshot({ path: `test-results/theme-${theme}.png`, fullPage: true });
    });

    test("axe finds no contrast violations when available", async ({ page }) => {
      const AxeBuilder = await loadAxe();
      test.skip(AxeBuilder === null, "@axe-core/playwright is not installed (task 8.3)");
      if (AxeBuilder === null) return;
      const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
