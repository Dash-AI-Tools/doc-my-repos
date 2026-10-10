import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Task 7.8: enlarge, pan and zoom view for Mermaid diagrams, in both themes.
 * Runs against the fixture page `/e2e/mermaid` (src/app/e2e/mermaid/page.tsx), which renders a
 * real pipeline document through the real client components.
 */

const FIXTURE = "/e2e/mermaid";

function trigger(page: Page): Locator {
  return page.getByRole("button", { name: "Enlarge diagram" });
}

function dialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Diagram" });
}

function content(page: Page): Locator {
  return page.getByTestId("mermaid-viewer-content");
}

async function transformOf(page: Page): Promise<string> {
  return (await content(page).getAttribute("style")) ?? "";
}

function scaleOf(style: string): number {
  const match = /scale\(([\d.]+)\)/.exec(style);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

function translateOf(style: string): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(style);
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`enlarge view, ${theme} theme`, () => {
    test.use({ colorScheme: theme });

    let problems: string[];

    test.beforeEach(async ({ page }) => {
      problems = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      await page.goto(FIXTURE);
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
      await expect(page.locator(".dmr-mermaid-diagram svg")).toBeVisible({ timeout: 30_000 });
    });

    test.afterEach(() => {
      expect(problems).toEqual([]);
    });

    test("opens on click and closes with Escape, returning focus", async ({ page }, testInfo) => {
      await expect(dialog(page)).toBeHidden();
      await trigger(page).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).locator("svg").first()).toBeVisible();
      // The inline diagram is still there, and ids are not duplicated.
      await expect(page.locator(".dmr-mermaid-diagram svg")).toBeVisible();
      const duplicateIds = await page.evaluate(() => {
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const el of document.querySelectorAll("[id]")) {
          if (seen.has(el.id)) dupes.push(el.id);
          seen.add(el.id);
        }
        return dupes;
      });
      expect(duplicateIds).toEqual([]);
      await expect(page.getByRole("group", { name: /pan and zoom area/i })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");

      await page.screenshot({ path: testInfo.outputPath(`enlarged-${theme}.png`) });
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.screenshot({ path: testInfo.outputPath(`enlarged-${theme}-zoomed.png`) });

      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
      await expect(trigger(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");
    });

    test("page chrome follows the theme", async ({ page }, testInfo) => {
      await page.screenshot({ path: testInfo.outputPath(`page-${theme}.png`) });
      await trigger(page).click();
      const panel = dialog(page).locator("> div").first();
      // Tailwind v4 computes colors in lab/oklch; reading the pixel gives plain RGB.
      const luminance = await panel.evaluate((el) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no canvas");
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      });
      if (theme === "dark") expect(luminance).toBeLessThan(60);
      else expect(luminance).toBeGreaterThan(220);
    });

    for (const key of ["Enter", "Space"]) {
      test(`opens from the keyboard with ${key}`, async ({ page }) => {
        const button = trigger(page);
        for (
          let i = 0;
          i < 12 && !(await button.evaluate((el) => el === document.activeElement));
          i++
        ) {
          await page.keyboard.press("Tab");
        }
        await expect(button).toBeFocused();
        await page.keyboard.press(key);
        await expect(dialog(page)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog(page)).toBeHidden();
        await expect(button).toBeFocused();
      });
    }

    test("closes with the Close button and with a backdrop click", async ({ page }) => {
      await trigger(page).click();
      await dialog(page).getByRole("button", { name: "Close" }).click();
      await expect(dialog(page)).toBeHidden();
      await expect(trigger(page)).toBeFocused();

      await trigger(page).click();
      await expect(dialog(page)).toBeVisible();
      await page.mouse.click(3, 3);
      await expect(dialog(page)).toBeHidden();
      await expect(trigger(page)).toBeFocused();
    });

    test("keeps focus inside the dialog while it is open", async ({ page }) => {
      await trigger(page).click();
      await expect(dialog(page)).toBeVisible();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        // The page behind is inert: focus is in the dialog or has left the page (browser UI).
        const state = await page.evaluate(() => {
          const active = document.activeElement;
          return {
            inDialog: document.querySelector("dialog")?.contains(active) ?? false,
            onBody: active === document.body || active === null,
          };
        });
        expect(state.inDialog || state.onBody).toBe(true);
      }
    });

    test("pans by dragging and zooms with the buttons, wheel and keys", async ({ page }) => {
      await trigger(page).click();
      const stage = page.getByRole("group", { name: /pan and zoom area/i });
      await expect(content(page)).toBeVisible();
      const initial = await transformOf(page);
      expect(initial).toContain("scale(1)");

      const box = await stage.boundingBox();
      if (box === null) throw new Error("no stage box");
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 80, cy + 30, { steps: 5 });
      await page.mouse.up();
      const dragged = translateOf(await transformOf(page));
      expect(dragged.x).toBeCloseTo(80, 0);
      expect(dragged.y).toBeCloseTo(30, 0);
      expect(await transformOf(page)).not.toBe(initial);

      await page.getByRole("button", { name: "Zoom in" }).click();
      expect(scaleOf(await transformOf(page))).toBeCloseTo(1.25, 2);
      await page.getByRole("button", { name: "Zoom out" }).click();
      await page.getByRole("button", { name: "Zoom out" }).click();
      expect(scaleOf(await transformOf(page))).toBeCloseTo(0.8, 2);

      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -300);
      await expect.poll(async () => scaleOf(await transformOf(page))).toBeGreaterThan(0.8);

      await stage.focus();
      await page.keyboard.press("0");
      expect(await transformOf(page)).toBe(initial);
      await page.keyboard.press("ArrowRight");
      expect(translateOf(await transformOf(page)).x).toBe(48);
      await page.keyboard.press("+");
      expect(scaleOf(await transformOf(page))).toBeCloseTo(1.25, 2);

      // The page behind did not scroll and a reopen starts fresh.
      await page.keyboard.press("Escape");
      await trigger(page).click();
      expect(await transformOf(page)).toBe(initial);
    });

    test("clamps the zoom", async ({ page }) => {
      await trigger(page).click();
      const zoomIn = page.getByRole("button", { name: "Zoom in" });
      for (let i = 0; i < 20; i++) await zoomIn.click();
      expect(scaleOf(await transformOf(page))).toBe(8);
      const zoomOut = page.getByRole("button", { name: "Zoom out" });
      for (let i = 0; i < 30; i++) await zoomOut.click();
      expect(scaleOf(await transformOf(page))).toBe(0.25);
    });
  });
}

test("a code block on the same page still gets its copy button", async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.getByRole("button", { name: "Copy code" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Enlarge diagram" })).toHaveCount(1);
});

test("external image in a Mermaid label (strict mode): records what the browser requests", async ({
  page,
}, testInfo) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) external.push(request.url());
  });
  await page.route("**/example.invalid/**", (route) => route.abort());
  await page.goto(`${FIXTURE}?doc=external-image`);
  await expect(page.locator(".dmr-mermaid-diagram svg")).toBeVisible({ timeout: 30_000 });
  const labelMarkup = await page
    .locator(".dmr-mermaid-diagram")
    .evaluate((el) => ({ hasImg: el.querySelector("img") !== null, html: el.innerHTML.length }));
  // Give a pending image request time to be issued.
  await page.waitForTimeout(500);
  testInfo.annotations.push({
    type: "external-image",
    description: `img element in svg: ${labelMarkup.hasImg}; external requests: ${JSON.stringify(external)}`,
  });
  console.log(
    `[external-image] img element present: ${labelMarkup.hasImg}; external requests attempted: ${external.length} ${JSON.stringify(external)}`,
  );
});
