import type { Locator, Page } from "@playwright/test";

/** The one reading options button in the top bar (text size, read mode and theme live in its panel). */
export const readingButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Text size and reading options" }).first();

/** Opens the reading options panel if it is closed, so its theme and size controls are reachable. */
export async function openReadingPanel(page: Page): Promise<void> {
  const button = readingButton(page);
  await button.waitFor({ state: "visible" });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}
