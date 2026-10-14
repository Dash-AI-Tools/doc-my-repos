import type { BrowserContext, Page } from "@playwright/test";

/** A valid 1x1 PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Answers every request to the image proxy (`/api/asset/**`) with a 1x1 PNG, so a page with
 * images does not make the e2e server contact GitHub (the seeded stack has no real credentials).
 * Returns the paths requested, in order.
 */
export async function stubAssets(page: Page | BrowserContext): Promise<string[]> {
  const requested: string[] = [];
  await page.route("**/api/asset/**", (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  return requested;
}
