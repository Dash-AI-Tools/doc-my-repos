import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect } from "./csp";

/**
 * Layout and accessibility checks shared by the e2e specs that test a new page in both themes and
 * at phone width with the largest text size: an axe pass, no horizontal scroll, nothing outside
 * the viewport, and targets of at least 24 by 24 CSS pixels (WCAG 2.5.8).
 */

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
export const INTERACTIVE =
  "a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex='-1'])";

export async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    [],
  );
}

/** No horizontal page scroll, and nothing inside `root` sticks out of the viewport. */
export async function expectFits(page: Page, root: Locator, label: string): Promise<void> {
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scroll.scrollWidth, `${label}: horizontal page scroll`).toBeLessThanOrEqual(
    scroll.innerWidth,
  );
  const wide = await root.evaluate((el) => {
    const limit = window.innerWidth;
    return Array.from(el.querySelectorAll("*"))
      .filter((child) => !child.closest("pre")) // a code block scrolls inside itself
      .map((child) => ({ child, rect: child.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && (rect.right > limit + 0.5 || rect.left < -0.5))
      .slice(0, 5)
      .map(
        ({ child, rect }) =>
          `${child.tagName.toLowerCase()} ${Math.round(rect.left)}..${Math.round(rect.right)}`,
      );
  });
  expect(wide, `${label}: elements outside the viewport`).toEqual([]);
}

/** Every visible control inside `root` is at least 24 by 24 CSS pixels. */
export async function expectTargets(root: Locator, label: string): Promise<void> {
  const small = await root.evaluate((el, selector) => {
    return Array.from(el.querySelectorAll<HTMLElement>(selector))
      .filter((control) => control.getClientRects().length > 0)
      .filter((control) => !(control as HTMLElement).classList.contains("sr-only"))
      .map((control) => ({
        control,
        // A checkbox or radio is clicked through its label, which is the target.
        rect: (
          (control instanceof HTMLInputElement &&
            (control.type === "checkbox" || control.type === "radio") &&
            control.labels?.[0]) ||
          control
        ).getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.width < 24 || rect.height < 24)
      .slice(0, 8)
      .map(
        ({ control, rect }) =>
          `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      );
  }, INTERACTIVE);
  expect(small, `${label}: targets under 24x24`).toEqual([]);
}
