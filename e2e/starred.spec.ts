import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./support/csp";
import { SEED_REPOS, SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Starred repositories and the account menu, end to end (starred-repos, task 5.1).
 *
 * Runs on the `starred` server (its own seeded database), because it stars, reorders and blocks
 * repositories, which would disturb the read-only specs that share `seeded`. The e2e servers run
 * with E2E_AUTH_BYPASS, so every request is an admin. The tests are serial: each builds on the
 * state the one before left (api-service, knowledge-base, search-lab starred in that order).
 *
 * Authorization (401/403), validation and the 409 are covered with a real database in
 * `src/server/admin/service.test.ts`; component behaviour in the `*.test.tsx` files next to the
 * components. This file covers what needs a real browser: pointer dragging, the keyboard on a
 * real layout, the home page, the account menu and axe.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);
test.use({ baseURL: stackUrl("starred") });
test.describe.configure({ mode: "serial" });

const A = SEEDED.full; // acme/api-service
const B = SEEDED.okf; // acme/knowledge-base
const C = SEEDED.searchLab; // acme/search-lab
const label = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

const starredRegion = (page: Page) => page.getByRole("region", { name: /^Starred/ });

/**
 * dnd-kit starts listening for the arrow keys, and measures the rows, a moment after the pick-up,
 * and a key pressed in that first instant is lost. A person never presses that fast; the spec
 * pauses the way a person would.
 */
const settle = (page: Page) => page.waitForTimeout(250);

/** Starred repositories on the admin page, top to bottom (the handles are in row order). */
async function adminOrder(page: Page): Promise<string[]> {
  const names = await starredRegion(page)
    .getByRole("button", { name: /^Reorder / })
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  return names.map((n) => n.replace(/^Reorder /, ""));
}

/** Starred cards on the home page, top to bottom. */
async function homeOrder(page: Page): Promise<string[]> {
  await page.goto("/");
  const region = starredRegion(page);
  if ((await region.count()) === 0) return [];
  return region.getByRole("heading", { level: 3 }).allTextContents();
}

async function openAdmin(page: Page): Promise<void> {
  await page.goto("/admin/repos");
  await expect(page.getByRole("heading", { level: 1, name: "Repository access" })).toBeVisible();
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: "Starred order saved." })).toBeVisible();
}

test("a repository starred on the admin page leads the home page, last starred last", async ({
  page,
}) => {
  expect(await homeOrder(page)).toEqual([]);
  await expect(page.getByRole("heading", { level: 2, name: /^Starred/ })).toHaveCount(0);

  await openAdmin(page);
  for (const repo of [A, B, C]) {
    const star = page.getByRole("button", { name: `Star ${label(repo)}` });
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await star.click();
    await expect(page.getByText(`${label(repo)} is starred.`)).toBeVisible();
  }
  expect(await adminOrder(page)).toEqual([A, B, C].map(label));

  expect(await homeOrder(page)).toEqual([A, B, C].map(label));
  // Exactly one section each: the starred repositories are not repeated under Repositories.
  const rest = page.getByRole("region", { name: /^Repositories/ });
  await expect(rest.getByRole("link", { name: label(A), exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: /^Starred/ })).toContainText("(3)");
  await expect(page.getByRole("heading", { level: 2, name: /^Repositories/ })).toContainText(
    `(${SEED_REPOS.length - 3})`,
  );
  await expect(
    starredRegion(page).getByRole("link", { name: label(A), exact: true }),
  ).toBeVisible();
});

test("dragging a handle with the pointer reorders the list and the home page", async ({ page }) => {
  await openAdmin(page);
  const handle = (r: { owner: string; name: string }) =>
    page.getByRole("button", { name: `Reorder ${label(r)}` });
  const from = await handle(A).boundingBox();
  const to = await handle(C).boundingBox();
  if (!from || !to) throw new Error("handles not laid out");
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(x + 30, to.y + to.height / 2 + 10, { steps: 15 }); // sideways drift is ignored
  await page.mouse.up();
  await saved(page);
  expect(await adminOrder(page)).toEqual([B, C, A].map(label));
  expect(await homeOrder(page)).toEqual([B, C, A].map(label));
});

test("a click on a handle, or on Star, does not reorder anything", async ({ page }) => {
  await openAdmin(page);
  await page.getByRole("button", { name: `Reorder ${label(B)}` }).click();
  expect(await adminOrder(page)).toEqual([B, C, A].map(label));
  await expect(page.getByRole("status").filter({ hasText: "Starred order saved." })).toHaveCount(0);
});

test("the keyboard picks a row up, moves it and drops it", async ({ page }) => {
  await openAdmin(page);
  const handle = page.getByRole("button", { name: `Reorder ${label(A)}` });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(`Picked up ${label(A)}, position 3 of 3.`)).toBeAttached();
  await settle(page);
  await page.keyboard.press("ArrowUp");
  await expect(page.getByText(`${label(A)} moved to position 2 of 3.`)).toBeAttached();
  await settle(page);
  await page.keyboard.press("ArrowUp");
  await expect(page.getByText(`${label(A)} moved to position 1 of 3.`)).toBeAttached();
  await page.keyboard.press("Space");
  await expect(page.getByText(`Dropped ${label(A)} at position 1 of 3.`)).toBeAttached();
  await saved(page);
  expect(await adminOrder(page)).toEqual([A, B, C].map(label));

  // Escape cancels: nothing is sent and the order stays.
  await handle.focus();
  await page.keyboard.press("Space");
  await settle(page);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByText(`${label(A)} moved to position 2 of 3.`)).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page.getByText(`Cancelled. ${label(A)} stays at position 1 of 3.`)).toBeAttached();
  expect(await adminOrder(page)).toEqual([A, B, C].map(label));
  expect(await homeOrder(page)).toEqual([A, B, C].map(label));
});

test("Move up and Move down reorder without dragging", async ({ page }) => {
  await openAdmin(page);
  await expect(page.getByRole("button", { name: `Move up ${label(A)}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Move down ${label(C)}` })).toHaveCount(0);
  await page.getByRole("button", { name: `Move up ${label(C)}` }).click();
  await saved(page);
  expect(await adminOrder(page)).toEqual([A, C, B].map(label));
  expect(await homeOrder(page)).toEqual([A, C, B].map(label));
});

test("a blocked starred repository is hidden, and returns in its place when allowed again", async ({
  page,
}) => {
  await openAdmin(page);
  await page.getByRole("button", { name: `Block ${label(C)}` }).click();
  await expect(page.getByText(`${label(C)} is blocked.`)).toBeVisible();
  // Still in the admin starred group, marked blocked, so it can be moved or unstarred.
  expect(await adminOrder(page)).toEqual([A, C, B].map(label));
  await expect(starredRegion(page).getByText("Blocked")).toHaveCount(1);
  expect(await homeOrder(page)).toEqual([A, B].map(label));

  await openAdmin(page);
  await page.getByRole("button", { name: `Allow ${label(C)}` }).click();
  await expect(page.getByText(`${label(C)} is visible again.`)).toBeVisible();
  expect(await homeOrder(page)).toEqual([A, C, B].map(label));
});

test("unstarring returns a repository to the list", async ({ page }) => {
  await openAdmin(page);
  await starredRegion(page)
    .getByRole("button", { name: `Star ${label(C)}` })
    .click();
  await expect(page.getByText(`${label(C)} is no longer starred.`)).toBeVisible();
  expect(await adminOrder(page)).toEqual([A, B].map(label));
  expect(await homeOrder(page)).toEqual([A, B].map(label));
  await expect(
    page
      .getByRole("region", { name: /^Repositories/ })
      .getByRole("link", { name: label(C), exact: true }),
  ).toBeVisible();
});

test("an admin reaches the admin pages through the email menu; the top bar has no Admin link", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  await expect(header.getByRole("button", { name: /sign out/i })).toHaveCount(0);

  for (const [name, path] of [
    ["Users", "/admin/users"],
    ["Repository access", "/admin/repos"],
    ["Workspace configuration", "/admin/workspace"],
  ] as const) {
    await page.goto("/");
    await page.getByTestId("account-menu-trigger").click();
    await page.getByTestId("account-menu").getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  await page.getByTestId("account-menu-trigger").click();
  await expect(
    page.getByTestId("account-menu").getByRole("link", { name: "Repository access" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("account-menu").getByRole("button", { name: "Sign out" }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`axe is clean on the home page with a Starred section and on /admin/repos (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem("docmyrepos-theme", value), theme);
    await page.goto("/");
    await expect(starredRegion(page)).toBeVisible();
    const home = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(home.violations, JSON.stringify(home.violations, null, 2)).toEqual([]);

    await openAdmin(page);
    await expect(starredRegion(page)).toBeVisible();
    const admin = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(admin.violations, JSON.stringify(admin.violations, null, 2)).toEqual([]);
  });
}

test("dragging works at phone width: the handle does not scroll the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openAdmin(page);
  const handle = page.getByRole("button", { name: `Reorder ${label(A)}` });
  await expect(handle).toHaveCSS("touch-action", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const from = await handle.boundingBox();
  const to = await page.getByRole("button", { name: `Reorder ${label(B)}` }).boundingBox();
  if (!from || !to) throw new Error("handles not laid out");
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(x, to.y + to.height / 2 + 10, { steps: 15 });
  await page.mouse.up();
  await saved(page);
  expect(await adminOrder(page)).toEqual([B, A].map(label));
});

for (const theme of ["light", "dark"] as const) {
  test(`the Starred section and the admin list fit a phone in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem("docmyrepos-theme", value), theme);
    await page.setViewportSize({ width: 390, height: 800 });
    for (const [name, path] of [
      ["home", "/"],
      ["admin", "/admin/repos"],
    ] as const) {
      await page.goto(path);
      await expect(starredRegion(page)).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} has no horizontal scroll`,
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${theme}-phone.png`),
        fullPage: true,
      });
    }
  });
}
