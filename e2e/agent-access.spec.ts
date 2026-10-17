import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { openSession, type SessionOptions } from "./support/comments";
import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON } from "./support/stack";

/**
 * The AI agent access pages end to end (mcp-agent-access tasks 2.4 and 6.1), on the `comments`
 * server (its seeded users: ana and ben are viewers, olga is an administrator). Each user is a
 * browser context whose requests carry `x-e2e-user`.
 *
 * Checked here: creating a token and the one-time display (and that a reload never shows it
 * again), revoking with the in-page confirmation, that a viewer sees only their own tokens while
 * an administrator sees and revokes everyone's, an axe pass in both themes (WCAG 2.0/2.1 A and AA
 * plus best practices, which includes the contrast minimums) with each state open, and that the
 * page fits 320 CSS pixels at the largest text size. Calls made with a token (the MCP protocol)
 * are covered by `mcp.spec.ts`.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);
test.describe.configure({ mode: "serial" });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const THEMES = ["light", "dark"] as const;
// Each theme starts from a user with no tokens: the specs run in order on one database.
const FRESH_USER = { light: "rita", dark: "otto" } as const;
const PHONE: Pick<SessionOptions, "viewport" | "textSize"> = {
  viewport: { width: 320, height: 640 },
  textSize: "largest",
};

const TOKEN = /dmr_[A-Za-z0-9_-]{43}/;

async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    [],
  );
}

async function openAccount(page: Page): Promise<void> {
  await page.goto("/account/agent-access");
  await expect(page.getByRole("heading", { level: 1, name: "AI agent access" })).toBeVisible();
  // The form only works once the page is interactive.
  await expect(page.getByLabel("Token name")).toBeEnabled();
  await expect(page.getByTestId("mcp-address")).toHaveText(/\/api\/mcp$/);
}

async function openAdmin(page: Page): Promise<void> {
  await page.goto("/admin/tokens");
  await expect(page.getByRole("heading", { level: 1, name: "AI agent tokens" })).toBeVisible();
}

/** Creates a token and returns the full text shown once. */
async function create(page: Page, name: string, expiry = "90 days"): Promise<string> {
  await page.getByLabel("Token name").fill(name);
  await page.getByLabel("Expires after").selectOption({ label: expiry });
  await page.getByRole("button", { name: "Create token" }).click();
  const panel = page.getByTestId("new-token");
  await expect(panel).toBeFocused();
  const value = await panel.getByLabel("Token").inputValue();
  expect(value).toMatch(TOKEN);
  return value;
}

const item = (page: Page, name: string) => page.getByTestId("token-item").filter({ hasText: name });

test("a user creates a token, sees it once, and it is gone after a reload", async ({ browser }) => {
  const ana = await openSession(browser, { user: "ana" });
  try {
    await openAccount(ana.page);
    await expect(ana.page.getByTestId("no-tokens")).toBeVisible();

    const token = await create(ana.page, "laptop", "30 days");
    const panel = ana.page.getByTestId("new-token");
    await expect(panel).toContainText("only time it is shown");
    await expect(panel).toContainText(`Bearer ${token}`);
    await expect(item(ana.page, "laptop")).toContainText("Active");
    await expect(item(ana.page, "laptop")).toContainText(`dmr_${token.slice(4, 12)}…`);
    await expect(item(ana.page, "laptop")).not.toContainText(token);

    // After "saved" and after a reload, the page holds no token, only its row.
    await panel.getByRole("button", { name: "I have saved the token" }).click();
    await expect(ana.page.getByTestId("new-token")).toHaveCount(0);
    expect(await ana.page.content()).not.toContain(token);
    await ana.page.reload();
    await expect(item(ana.page, "laptop")).toBeVisible();
    expect(await ana.page.content()).not.toContain(token);
    expect(await ana.page.locator("body").innerText()).not.toMatch(TOKEN);
    expect(ana.page.url()).not.toContain("dmr_");
  } finally {
    await ana.close();
  }
});

test("a user names the problem when the input is bad", async ({ browser }) => {
  const ana = await openSession(browser, { user: "ana" });
  try {
    await openAccount(ana.page);
    await ana.page.getByRole("button", { name: "Create token" }).click();
    await expect(ana.page.getByTestId("agent-access-error")).toContainText("name");
    await expect(ana.page.getByTestId("new-token")).toHaveCount(0);
  } finally {
    await ana.close();
  }
});

test("revoking asks first, and the revoked token stays listed as revoked", async ({ browser }) => {
  const ana = await openSession(browser, { user: "ana" });
  try {
    await openAccount(ana.page);
    await ana.page.getByRole("button", { name: "Revoke laptop" }).click();
    await ana.page.getByRole("button", { name: "Cancel" }).click();
    await expect(item(ana.page, "laptop")).toContainText("Active");

    await ana.page.getByRole("button", { name: "Revoke laptop" }).click();
    await ana.page.getByRole("button", { name: "Yes, revoke" }).click();
    await expect(item(ana.page, "laptop")).toContainText("Revoked");
    await expect(ana.page.getByTestId("agent-access-message")).toContainText("Revoked “laptop”");
    await ana.page.reload();
    await expect(item(ana.page, "laptop")).toContainText("Revoked");
    await expect(ana.page.getByRole("button", { name: "Revoke laptop" })).toHaveCount(0);
  } finally {
    await ana.close();
  }
});

test("a viewer sees only their own tokens, an administrator sees and revokes everyone's", async ({
  browser,
}) => {
  const ben = await openSession(browser, { user: "ben" });
  const ana = await openSession(browser, { user: "ana" });
  const olga = await openSession(browser, { user: "olga" });
  try {
    await openAccount(ben.page);
    await create(ben.page, "bens agent");
    await openAccount(ana.page);
    await create(ana.page, "anas agent");

    // Each viewer sees only their own.
    await ben.page.reload();
    await expect(item(ben.page, "bens agent")).toBeVisible();
    await expect(ben.page.getByText("anas agent")).toHaveCount(0);

    // A viewer is refused the administrator page and its API.
    await ben.page.goto("/admin/tokens");
    await expect(ben.page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    const refused = await ben.context.request.get("/api/admin/tokens");
    expect(refused.status()).toBe(403);

    // The administrator sees every token with its owner and revokes one.
    await openAdmin(olga.page);
    const adminItem = (name: string) =>
      olga.page.getByTestId("admin-token-item").filter({ hasText: name });
    await expect(adminItem("bens agent")).toContainText("ben@example.com");
    await expect(adminItem("anas agent")).toContainText("ana@example.com");
    await olga.page.getByRole("button", { name: "Revoke bens agent" }).click();
    await olga.page.getByRole("button", { name: "Yes, revoke" }).click();
    await expect(adminItem("bens agent")).toContainText("Revoked");

    // The owner sees it as revoked.
    await ben.page.goto("/account/agent-access");
    await expect(item(ben.page, "bens agent")).toContainText("Revoked");
  } finally {
    await ben.close();
    await ana.close();
    await olga.close();
  }
});

test("the account menu links to the agent pages, the administrator's also to the token list", async ({
  browser,
}) => {
  const ana = await openSession(browser, { user: "ana" });
  const olga = await openSession(browser, { user: "olga" });
  try {
    await ana.page.goto("/");
    await ana.page.getByTestId("account-menu-trigger").click();
    await expect(ana.page.getByRole("link", { name: "AI agent access" })).toBeVisible();
    await expect(ana.page.getByRole("link", { name: "AI agent tokens" })).toHaveCount(0);
    await ana.page.getByRole("link", { name: "AI agent access" }).click();
    await expect(ana.page).toHaveURL(/\/account\/agent-access$/);

    await olga.page.goto("/admin");
    await expect(olga.page.getByRole("link", { name: "AI agent tokens" })).toBeVisible();
    await olga.page.getByTestId("account-menu-trigger").click();
    await expect(olga.page.getByRole("link", { name: "AI agent tokens" }).last()).toBeVisible();
  } finally {
    await ana.close();
    await olga.close();
  }
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test(`axe is clean on the AI agent access page: empty, with a new token shown, with a revoke confirmation (${theme})`, async ({
      browser,
    }) => {
      const rita = await openSession(browser, { user: FRESH_USER[theme], theme });
      try {
        await openAccount(rita.page);
        await expect(rita.page.getByTestId("no-tokens")).toBeVisible();
        await expectAxeClean(rita.page, `empty (${theme})`);

        await create(rita.page, `axe ${theme}`);
        await expectAxeClean(rita.page, `new token shown (${theme})`);

        await rita.page.getByRole("button", { name: "I have saved the token" }).click();
        await rita.page.getByRole("button", { name: `Revoke axe ${theme}` }).click();
        await expect(rita.page.getByRole("button", { name: "Yes, revoke" })).toBeVisible();
        await expectAxeClean(rita.page, `revoke confirmation (${theme})`);
        await rita.page.getByRole("button", { name: "Yes, revoke" }).click();
        await expect(item(rita.page, `axe ${theme}`)).toContainText("Revoked");
        await expectAxeClean(rita.page, `with a revoked token (${theme})`);
      } finally {
        await rita.close();
      }
    });

    test(`axe is clean on the administrator's token list, with a confirmation open (${theme})`, async ({
      browser,
    }) => {
      const olga = await openSession(browser, { user: "olga", theme });
      try {
        await openAdmin(olga.page);
        await expect(olga.page.getByTestId("admin-token-item").first()).toBeVisible();
        await expectAxeClean(olga.page, `admin list (${theme})`);
        const revoke = olga.page.getByRole("button", { name: /^Revoke / }).first();
        if (await revoke.count()) {
          await revoke.click();
          await expect(olga.page.getByRole("button", { name: "Yes, revoke" })).toBeVisible();
          await expectAxeClean(olga.page, `admin confirmation (${theme})`);
        }
      } finally {
        await olga.close();
      }
    });

    test(`the account page fits 320 CSS pixels at the largest text size (${theme})`, async ({
      browser,
    }) => {
      const rita = await openSession(browser, { user: "rita", theme, ...PHONE });
      try {
        await openAccount(rita.page);
        await create(rita.page, `phone ${theme}`);
        const scroll = await rita.page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(scroll.scrollWidth, "horizontal page scroll").toBeLessThanOrEqual(scroll.innerWidth);
        await expect(rita.page.getByTestId("new-token")).toBeInViewport({ ratio: 0.01 });
      } finally {
        await rita.close();
      }
    });
  });
}
