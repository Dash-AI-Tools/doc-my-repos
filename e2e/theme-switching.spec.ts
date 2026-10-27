import type { Browser, Locator, Page } from "@playwright/test";

import { THEME_TOKENS, type ThemeName } from "../packages/core/src/theme-tokens";
import { expect, test } from "./support/csp";
import { openReadingPanel, readingButton } from "./support/reading-panel";

/**
 * Task 8.2: theme switching in a real browser (Chromium).
 *
 * Covers the theming spec: system preference on a first visit, a manual choice that survives a
 * reload, no flash of the wrong theme before first paint, the header toggle on every page and its
 * keyboard operation, and live updates of code blocks and Mermaid diagrams. The key is
 * `docmyrepos-theme` (packages/ui/src/components/theme-provider.tsx). Fixture pages (`/e2e/*`, see
 * packages/core/src/e2e-fixtures.ts) stand in for document pages until group 10. Screenshots go to
 * `test-results/` for inspection.
 */

const KEY = "docmyrepos-theme";
const HOME = "/";
const MERMAID = "/e2e/mermaid";

function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

function isDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

async function expectTheme(page: Page, theme: ThemeName): Promise<void> {
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  const background = await page
    .locator("body")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).toBe(rgb(THEME_TOKENS[theme].background));
  const scheme = await page.locator("html").evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toBe(theme);
}

function toggle(page: Page): Locator {
  return page.getByRole("radiogroup", { name: "Theme" });
}

function option(page: Page, name: "Light" | "Dark" | "System"): Locator {
  return toggle(page).getByRole("radio", { name });
}

function stored(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), KEY);
}

test.describe("system preference on a first visit", () => {
  for (const scheme of ["dark", "light"] as const) {
    test.describe(`OS prefers ${scheme}`, () => {
      test.use({ colorScheme: scheme });

      test(`renders the ${scheme} theme with nothing stored`, async ({ page }, testInfo) => {
        await page.goto(HOME);
        await openReadingPanel(page);
        expect(await stored(page)).toBeNull();
        await expectTheme(page, scheme);
        await expect(option(page, "System")).toHaveAttribute("aria-checked", "true");
        await page.screenshot({ path: testInfo.outputPath(`home-${scheme}.png`) });
      });
    });
  }
});

test.describe("manual choice persists", () => {
  test.use({ colorScheme: "dark" });

  test("light survives a reload while the OS prefers dark, then dark, then system", async ({
    page,
  }) => {
    await page.goto(HOME);
    await openReadingPanel(page);
    await expectTheme(page, "dark");

    await option(page, "Light").click();
    await expectTheme(page, "light");
    expect(await stored(page)).toBe("light");
    await page.reload();
    await openReadingPanel(page);
    await expectTheme(page, "light");
    await expect(option(page, "Light")).toHaveAttribute("aria-checked", "true");
    await expect(option(page, "System")).toHaveAttribute("aria-checked", "false");

    await page.emulateMedia({ colorScheme: "light" });
    await option(page, "Dark").click();
    await expectTheme(page, "dark");
    expect(await stored(page)).toBe("dark");
    await page.reload();
    await openReadingPanel(page);
    await expectTheme(page, "dark");
    await expect(option(page, "Dark")).toHaveAttribute("aria-checked", "true");
  });

  test("system follows the OS across a reload and reacts live to OS changes", async ({ page }) => {
    await page.goto(HOME);
    await openReadingPanel(page);
    await option(page, "Light").click();
    await expectTheme(page, "light");

    await option(page, "System").click();
    expect(await stored(page)).toBe("system");
    await expectTheme(page, "dark");
    await page.reload();
    await openReadingPanel(page);
    await expectTheme(page, "dark");
    await expect(option(page, "System")).toHaveAttribute("aria-checked", "true");

    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, "light");
    // The choice stays System while the page follows the OS.
    await expect(option(page, "System")).toHaveAttribute("aria-checked", "true");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme(page, "dark");
    await page.reload();
    await openReadingPanel(page);
    await expectTheme(page, "dark");
  });

  test("a manual choice ignores later OS changes", async ({ page }) => {
    await page.goto(HOME);
    await openReadingPanel(page);
    await option(page, "Light").click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme(page, "light");
  });

  test("a stale stored value falls back to the system theme", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "sepia"), KEY);
    await page.goto(HOME);
    await openReadingPanel(page);
    await expect(option(page, "System")).toHaveAttribute("aria-checked", "true");
  });
});

/** Stall every script chunk so the page must paint before React hydrates. */
async function stallScripts(page: Page, ms: number): Promise<void> {
  await page.route("**/_next/static/**/*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

/** Colour of one pixel of a PNG, decoded in the browser so no image library is needed. */
async function pixelOf(browser: Browser, png: Buffer, x: number, y: number): Promise<number[]> {
  const context = await browser.newContext();
  try {
    const helper = await context.newPage();
    await helper.goto("about:blank");
    return await helper.evaluate(
      async ({ base64, px, py }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no 2d context");
        ctx.drawImage(image, 0, 0);
        return Array.from(ctx.getImageData(px, py, 1, 1).data);
      },
      { base64: png.toString("base64"), px: x, py: y },
    );
  } finally {
    await context.close();
  }
}

/** Perceived brightness 0..255 of an rgb pixel. */
function brightness([r = 0, g = 0, b = 0]: number[]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A visitor whose stored choice is dark but whose OS prefers light (so only storage says dark). */
async function storedDarkContext(browser: Browser, baseURL: string | undefined) {
  if (baseURL === undefined) throw new Error("baseURL is required");
  return browser.newContext({
    baseURL,
    colorScheme: "light",
    storageState: {
      cookies: [],
      origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: KEY, value: "dark" }] }],
    },
  });
}

test.describe("no flash of the wrong theme", () => {
  const SAMPLE_AT = { x: 1200, y: 500 };

  test("a stored-dark visitor is painted dark before any script chunk has loaded", async ({
    browser,
    baseURL,
  }, testInfo) => {
    const context = await storedDarkContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await stallScripts(page, 2000);
      await page.addInitScript(() => {
        const w = window as unknown as { __classAtHeader?: string };
        new MutationObserver((_records, observer) => {
          if (document.querySelector("header") === null) return;
          w.__classAtHeader = document.documentElement.className;
          observer.disconnect();
        }).observe(document, { childList: true, subtree: true });
      });

      await page.goto(HOME, { waitUntil: "commit" });
      await expect(page.locator("header")).toBeVisible();
      // Hydration has not happened: the toggle is still the inert placeholder.
      await expect(page.getByTestId("text-size-placeholder")).toBeVisible();
      await expect(readingButton(page)).toHaveCount(0);
      const placeholderBox = await page.getByTestId("text-size-placeholder").boundingBox();

      const shot = await page.screenshot({ path: testInfo.outputPath("pre-hydration-dark.png") });
      expect(brightness(await pixelOf(browser, shot, SAMPLE_AT.x, SAMPLE_AT.y))).toBeLessThan(40);
      expect(brightness(await pixelOf(browser, shot, 5, 5))).toBeLessThan(40);
      expect(await isDark(page)).toBe(true);
      expect(
        await page.evaluate(
          () => (window as unknown as { __classAtHeader?: string }).__classAtHeader,
        ),
      ).toContain("dark");

      // After hydration it is still dark, and the real button took the placeholder's place.
      await expect(readingButton(page)).toBeVisible();
      expect(await readingButton(page).boundingBox()).toEqual(placeholderBox);
      await openReadingPanel(page);
      await expect(option(page, "Dark")).toHaveAttribute("aria-checked", "true");
      await expectTheme(page, "dark");
    } finally {
      await context.close();
    }
  });

  test("a stored-light visitor is painted light before hydration while the OS prefers dark", async ({
    browser,
    baseURL,
  }) => {
    if (baseURL === undefined) throw new Error("baseURL is required");
    const context = await browser.newContext({
      baseURL,
      colorScheme: "dark",
      storageState: {
        cookies: [],
        origins: [
          { origin: new URL(baseURL).origin, localStorage: [{ name: KEY, value: "light" }] },
        ],
      },
    });
    try {
      const page = await context.newPage();
      await stallScripts(page, 2000);
      await page.goto(HOME, { waitUntil: "commit" });
      await expect(page.getByTestId("text-size-placeholder")).toBeVisible();
      const shot = await page.screenshot();
      expect(brightness(await pixelOf(browser, shot, SAMPLE_AT.x, SAMPLE_AT.y))).toBeGreaterThan(
        240,
      );
    } finally {
      await context.close();
    }
  });

  test("control: without the inline script the same visit does paint light first", async ({
    browser,
    baseURL,
  }) => {
    const context = await storedDarkContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await stallScripts(page, 2000);
      await page.route(
        (url) => url.pathname === HOME,
        async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            /<script(?![^>]*\bsrc=)[^>]*>(?:(?!<\/script>)[\s\S])*?classList(?:(?!<\/script>)[\s\S])*?<\/script>/g,
            "",
          );
          await route.fulfill({ response, body });
        },
      );
      await page.goto(HOME, { waitUntil: "commit" });
      await expect(page.getByTestId("text-size-placeholder")).toBeVisible();
      expect(await isDark(page)).toBe(false);
      const shot = await page.screenshot();
      // This is what the spec forbids: the sampling sees a light page without the script.
      expect(brightness(await pixelOf(browser, shot, SAMPLE_AT.x, SAMPLE_AT.y))).toBeGreaterThan(
        240,
      );
      // And hydration then fixes it, so the user would see a flash.
      await expectTheme(page, "dark");
    } finally {
      await context.close();
    }
  });

  test("the served HTML has a blocking theme script before any page content", async ({
    request,
  }) => {
    const html = await (await request.get(HOME)).text();
    const body = html.slice(html.indexOf("<body"));
    const script = body.indexOf("<script");
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(body.indexOf("<header"));
    const tag = body.slice(script, body.indexOf(">", script));
    expect(tag).not.toMatch(/\b(async|defer|src)\b/);
    expect(body.slice(script, body.indexOf("</script>", script))).toContain(KEY);
    expect(html).toMatch(/<meta name="color-scheme" content="light dark"\/?>/);
    expect(html).toMatch(
      /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)"\/?>/,
    );
    expect(html).toMatch(
      /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"\/?>/,
    );
  });
});

test.describe("reading panel theme toggle", () => {
  for (const path of [HOME, MERMAID, "/e2e/theme"]) {
    test(`is present and keyboard operable on ${path}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(path);
      await openReadingPanel(page);
      await expect(toggle(page)).toBeVisible();
      await expect(toggle(page).getByRole("radio")).toHaveCount(3);

      // The theme group is in the reading panel; its roving tab stop is the selected option.
      // A key press first, so the browser treats the programmatic focus as keyboard focus (ring).
      await page.keyboard.press("Shift");
      await option(page, "System").focus();
      await expect(option(page, "System")).toBeFocused();
      const ring = await option(page, "System").evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
      });
      expect(ring).toEqual({ color: rgb(THEME_TOKENS.light.ring), style: "solid", width: "2px" });

      await page.keyboard.press("ArrowRight");
      await expect(option(page, "Light")).toBeFocused();
      await expect(option(page, "Light")).toHaveAttribute("aria-checked", "true");
      await expectTheme(page, "light");

      await page.keyboard.press("ArrowRight");
      await expect(option(page, "Dark")).toBeFocused();
      await expectTheme(page, "dark");
      await page.screenshot({
        path: testInfo.outputPath(`toggle-dark-${path.replace(/\W+/g, "_")}.png`),
      });

      await page.keyboard.press("Home");
      await expect(option(page, "Light")).toBeChecked();
      await page.keyboard.press("End");
      await expect(option(page, "System")).toBeChecked();
      await expectTheme(page, "light");

      // Space/Enter on a focused option selects it too.
      await option(page, "Dark").focus();
      await page.keyboard.press("Enter");
      await expectTheme(page, "dark");
      await option(page, "Light").focus();
      await page.keyboard.press("Space");
      await expectTheme(page, "light");
    });
  }

  test("exposes accessible names, a group label and a roving tab stop", async ({ page }) => {
    await page.goto(HOME);
    await openReadingPanel(page);
    await expect(toggle(page)).toBeVisible();
    for (const name of ["Light", "Dark", "System"] as const) {
      await expect(option(page, name)).toBeVisible();
    }
    expect(await option(page, "System").getAttribute("tabindex")).toBe("0");
    expect(await option(page, "Light").getAttribute("tabindex")).toBe("-1");
    expect(await option(page, "Dark").getAttribute("tabindex")).toBe("-1");
  });
});

test.describe("theme change updates content without a reload", () => {
  test.use({ colorScheme: "light" });

  test("Shiki block and Mermaid diagram follow the toggle", async ({ page }, testInfo) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto(MERMAID);
    await openReadingPanel(page);
    await expectTheme(page, "light");
    const diagram = page.locator(".dmr-mermaid-diagram svg");
    await expect(diagram).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      (window as unknown as { __noReload?: number }).__noReload = 1;
    });

    const code = page.locator("pre.shiki").first();
    const tokenColors = () =>
      code.locator("span span").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    const lightColors = await tokenColors();
    const lightCodeBackground = await code.evaluate((el) => getComputedStyle(el).backgroundColor);
    const lightSvg = await diagram.evaluate((el) => el.outerHTML);
    await page.screenshot({ path: testInfo.outputPath("content-light.png") });

    await option(page, "Dark").click();
    await expectTheme(page, "dark");

    expect(await tokenColors()).not.toEqual(lightColors);
    expect(await code.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      rgb(THEME_TOKENS.dark["code-background"]),
    );
    expect(lightCodeBackground).toBe(rgb(THEME_TOKENS.light["code-background"]));
    await expect
      .poll(() => diagram.evaluate((el) => el.outerHTML), { timeout: 15_000 })
      .not.toBe(lightSvg);
    await expect(diagram).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("content-dark.png") });
    const darkSvg = await diagram.evaluate((el) => el.outerHTML);

    // And back to light, again without a reload.
    await option(page, "Light").click();
    await expectTheme(page, "light");
    expect(await tokenColors()).toEqual(lightColors);
    await expect
      .poll(() => diagram.evaluate((el) => el.outerHTML), { timeout: 15_000 })
      .not.toBe(darkSvg);

    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload),
    ).toBe(1);
    expect(problems).toEqual([]);
  });
});
