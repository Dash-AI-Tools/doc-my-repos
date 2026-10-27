import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./support/csp";
import { SEED_REPOS, SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Folders, end to end (repo-folders, task 5.2).
 *
 * Runs on the `folders` server (its own seeded database), because it creates folders, assigns and
 * blocks repositories, which would disturb the read-only specs that share `seeded`. The e2e
 * servers run with E2E_AUTH_BYPASS, so every request is an admin. The tests are serial: each
 * builds on the state the one before left.
 *
 * Authorization, validation and the 409s are covered with a real database in
 * `packages/server/src/admin/*.test.ts`; component behaviour in the `*.test.tsx` files next to the
 * components. This file covers the flow in a real browser: the home page without folders, the
 * admin pages, sections, tabs and links, and axe.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);
test.use({ baseURL: stackUrl("folders") });
test.describe.configure({ mode: "serial" });

const A = SEEDED.full; // acme/api-service
const B = SEEDED.okf; // acme/knowledge-base
const C = SEEDED.searchLab; // acme/search-lab
const label = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

const folderPanel = (page: Page) => page.getByRole("tabpanel", { name: "Folders" });
const section = (page: Page, name: string) =>
  page.getByRole("region", { name: new RegExp(`^${name}`) });
const tabBar = (page: Page) => page.getByTestId("home-tabs");

async function openFolders(page: Page): Promise<void> {
  await page.goto("/admin/workspace?tab=folders");
  await expect(page.getByRole("tab", { name: "Folders", selected: true })).toBeVisible();
}

async function openRepos(page: Page): Promise<void> {
  await page.goto("/admin/workspace?tab=repos");
  await expect(page.getByRole("tab", { name: "Repository access", selected: true })).toBeVisible();
}

async function createFolder(page: Page, name: string, description: string): Promise<void> {
  await openFolders(page);
  const panel = folderPanel(page);
  await panel.getByLabel("Name").fill(name);
  await panel.getByLabel(/Description/).fill(description);
  await panel.getByRole("button", { name: "Create folder" }).click();
  await expect(panel.getByText(`Created ${name}.`)).toBeVisible();
}

async function assign(page: Page, repo: { owner: string; name: string }, folder: string) {
  await page.getByLabel(`Folder for ${label(repo)}`).selectOption({ label: folder });
  await expect(page.getByText(`${label(repo)} is in ${folder}.`)).toBeVisible();
}

test("with no folder the home page and the repository list are as before", async ({ page }) => {
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: /^Repositories/ })).toContainText(
    `(${SEED_REPOS.length})`,
  );
  await openRepos(page);
  await expect(page.getByLabel(/^Folder for /)).toHaveCount(0);
  await openFolders(page);
  await expect(folderPanel(page).getByText(/Folders are optional/)).toBeVisible();
  await expect(folderPanel(page).getByText("No folders yet.")).toBeVisible();
});

test("an admin creates folders, assigns repositories, and the home page groups them", async ({
  page,
}) => {
  await createFolder(page, "Payments", "Billing & <b>money</b> services");
  await createFolder(page, "Ops", "");
  await openRepos(page);
  await assign(page, A, "Payments");
  await assign(page, B, "Payments");
  await assign(page, C, "Ops");

  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(0); // folders exist, but none is starred
  const payments = section(page, "Payments");
  await expect(payments.getByRole("heading", { level: 2 })).toContainText("(2)");
  // The description is text, never markup.
  await expect(payments.getByText("Billing & <b>money</b> services")).toBeVisible();
  await expect(payments.getByRole("link", { name: label(A), exact: true })).toBeVisible();
  await expect(payments.getByRole("link", { name: label(B), exact: true })).toBeVisible();
  await expect(
    section(page, "Ops").getByRole("link", { name: label(C), exact: true }),
  ).toBeVisible();
  // Folders come before Repositories (by name: Ops, then Payments), and nothing is repeated.
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.map((h) => h.replace(/ \(\d+\)$/, "")).slice(-3)).toEqual([
    "Ops",
    "Payments",
    "Repositories",
  ]);
  await expect(page.getByRole("heading", { level: 2, name: /^Repositories/ })).toContainText(
    `(${SEED_REPOS.length - 3})`,
  );
  await expect(
    section(page, "Repositories").getByRole("link", { name: label(A), exact: true }),
  ).toHaveCount(0);
});

test("starring a folder adds a tab that opens its repositories; Up and Down reorder the tabs", async ({
  page,
}) => {
  await openFolders(page);
  const panel = folderPanel(page);
  await panel.getByRole("button", { name: "Star Payments" }).click();
  await expect(panel.getByText(/Payments is starred/)).toBeVisible();
  await panel.getByRole("button", { name: "Star Ops" }).click();
  await expect(panel.getByText(/Ops is starred/)).toBeVisible();

  await page.goto("/");
  const links = tabBar(page).getByRole("link");
  await expect(links).toHaveText(["All", "Payments", "Ops"]);
  await expect(tabBar(page).getByRole("link", { name: "All" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await tabBar(page).getByRole("link", { name: "Payments" }).click();
  await expect(page).toHaveURL(/\/\?folder=\d+$/);
  await expect(tabBar(page).getByRole("link", { name: "Payments" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Payments (2)");
  await expect(page.getByTestId("repo-card")).toHaveCount(2);

  // Reorder: Ops moves ahead of Payments.
  await openFolders(page);
  await folderPanel(page).getByRole("button", { name: "Move up Ops" }).click();
  await expect(folderPanel(page).getByText("Tab order saved.")).toBeVisible();
  await page.goto("/");
  await expect(tabBar(page).getByRole("link")).toHaveText(["All", "Ops", "Payments"]);
});

test("a starred repository shows under Starred in All and in its folder's tab", async ({
  page,
}) => {
  await openRepos(page);
  await page.getByRole("button", { name: `Star ${label(A)}` }).click();
  await expect(page.getByText(`${label(A)} is starred.`)).toBeVisible();

  await page.goto("/");
  await expect(
    section(page, "Starred").getByRole("link", { name: label(A), exact: true }),
  ).toBeVisible();
  await expect(
    section(page, "Payments").getByRole("link", { name: label(A), exact: true }),
  ).toHaveCount(0);
  await expect(section(page, "Payments").getByRole("heading", { level: 2 })).toContainText("(1)");

  await tabBar(page).getByRole("link", { name: "Payments" }).click();
  await expect(page.getByTestId("repo-card")).toHaveCount(2);
  await expect(page.getByRole("link", { name: label(A), exact: true })).toBeVisible();
});

test("an unusable folder link shows All", async ({ page }) => {
  for (const q of ["999999", "abc", "0"]) {
    await page.goto(`/?folder=${q}`);
    await expect(tabBar(page).getByRole("link", { name: "All" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 2, name: /^Repositories/ })).toBeVisible();
  }
});

test("blocking every repository of a folder hides its tab and section; allowing brings it back", async ({
  page,
}) => {
  await openRepos(page);
  await page.getByRole("button", { name: `Block ${label(C)}` }).click();
  await expect(page.getByText(`${label(C)} is blocked.`)).toBeVisible();
  await page.goto("/");
  await expect(tabBar(page).getByRole("link")).toHaveText(["All", "Payments"]);
  await expect(section(page, "Ops")).toHaveCount(0);

  await openRepos(page);
  await page.getByRole("button", { name: `Allow ${label(C)}` }).click();
  await expect(page.getByText(`${label(C)} is visible again.`)).toBeVisible();
  await page.goto("/");
  await expect(tabBar(page).getByRole("link")).toHaveText(["All", "Ops", "Payments"]);
});

for (const theme of ["light", "dark"] as const) {
  test(`axe is clean on the home page with sections and tabs, and on the Folders tab (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem("docmyrepos-theme", value), theme);
    await page.goto("/");
    await expect(tabBar(page)).toBeVisible();
    const home = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(home.violations, JSON.stringify(home.violations, null, 2)).toEqual([]);

    await openFolders(page);
    await expect(folderPanel(page).getByText("Payments").first()).toBeVisible();
    const folders = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(folders.violations, JSON.stringify(folders.violations, null, 2)).toEqual([]);

    await openRepos(page);
    await expect(page.getByLabel(`Folder for ${label(A)}`)).toBeVisible();
    const repos = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(repos.violations, JSON.stringify(repos.violations, null, 2)).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`the home page, tabs and Folders tab fit a phone in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem("docmyrepos-theme", value), theme);
    await page.setViewportSize({ width: 390, height: 800 });
    for (const [name, path] of [
      ["home", "/"],
      ["folders", "/admin/workspace?tab=folders"],
      ["access", "/admin/workspace?tab=repos"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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

test("deleting a folder keeps its repositories, which return to Repositories", async ({ page }) => {
  await openFolders(page);
  const panel = folderPanel(page);
  await panel.getByRole("button", { name: "Delete Payments" }).click();
  await expect(panel.getByText(/Delete Payments\?/)).toContainText("Its 2 repositories move");
  await panel.getByRole("button", { name: "Confirm delete Payments" }).click();
  await expect(panel.getByText(/Deleted Payments/)).toBeVisible();

  await page.goto("/");
  await expect(tabBar(page).getByRole("link")).toHaveText(["All", "Ops"]);
  await expect(section(page, "Payments")).toHaveCount(0);
  await expect(
    section(page, "Repositories").getByRole("link", { name: label(B), exact: true }),
  ).toBeVisible();

  // Deleting the last folder returns the page to how it was before any folder existed.
  await openFolders(page);
  await panel.getByRole("button", { name: "Delete Ops" }).click();
  await panel.getByRole("button", { name: "Confirm delete Ops" }).click();
  await expect(panel.getByText(/Deleted Ops/)).toBeVisible();
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: /^Starred/ })).toBeVisible();
});
