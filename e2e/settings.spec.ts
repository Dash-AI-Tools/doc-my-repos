import { createHmac, generateKeyPairSync } from "node:crypto";

import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "pg";

import { openSession } from "./support/comments";
import { expect, test } from "./support/csp";
import { expectAxeClean, expectFits, expectTargets } from "./support/layout";
import {
  SKIP_DB,
  SKIP_DB_REASON,
  databaseUrl,
  fakeGithubUrl,
  fakeProviderUrl,
  stackUrl,
} from "./support/stack";

/**
 * Workspace settings end to end (workspace-settings task 5.3), against the `settings` server: a
 * database with no settings at all, and a fake GitHub on a fixed loopback port that the server's
 * GitHub requests are redirected to. The specs follow one workspace from "nothing configured" to a
 * working sync, a webhook and Ask, entering everything in the admin interface, and check that no
 * secret is stored in clear text, shown again or sent back.
 *
 * Serial, because each step builds on the saved settings of the one database.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);
test.describe.configure({ mode: "serial" });

const BASE = stackUrl("settings");
const SYNC_SECRET = "e2e-sync-secret-not-a-real-secret";
const WEBHOOK = "e2e-webhook-secret-SENTINEL-0123";
const NEW_WEBHOOK = "e2e-webhook-secret-REPLACED-4567";
const INSTALLATION = "4242";

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
/** The base64 body of the key: a piece of it must never be found outside the form field. */
const KEY_BODY = PEM.split("\n")[2]!;

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function webhook(request: APIRequestContext, secret: string, event = "ping") {
  const body = JSON.stringify({ zen: "Keep it logically awesome.", installation: { id: 4242 } });
  return request.post(`${BASE}/api/webhooks/github`, {
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-hub-signature-256": sign(body, secret),
    },
    data: body,
  });
}

const githubRequests = async (request: APIRequestContext) =>
  (await (await request.get(`${fakeGithubUrl}/__control/requests`)).json()) as {
    method: string;
    path: string;
  }[];

/** Reads straight from the database, as someone with a backup would. */
async function dump(): Promise<string> {
  const client = new Client({ connectionString: databaseUrl("settings") });
  await client.connect();
  try {
    const rows = [
      ...(await client.query("SELECT * FROM workspace_settings")).rows,
      ...(await client.query("SELECT * FROM workspace_secrets")).rows,
      ...(await client.query("SELECT * FROM settings_audit")).rows,
    ];
    return JSON.stringify(rows);
  } finally {
    await client.end();
  }
}

async function fillGithub(page: Page, webhookSecret: string | null) {
  await page.getByLabel("App ID").fill("1");
  await page.getByLabel("Installation ID").fill(INSTALLATION);
  await page.getByLabel("Private key (PEM)").fill(PEM);
  if (webhookSecret) await page.getByLabel("Webhook secret").fill(webhookSecret);
}

test.describe("a fresh workspace", () => {
  test("shows an administrator a setup banner that opens the instructions, and names what is missing", async ({
    browser,
    request,
  }) => {
    await request.get(`${fakeGithubUrl}/__control/reset`);
    const admin = await openSession(browser, { stack: "settings" });
    try {
      // Nobody is redirected: the home page loads, with a banner that links to the instructions.
      await admin.page.goto("/");
      await expect(admin.page).toHaveURL(/\/$/);
      await expect(admin.page.getByTestId("empty-state")).toContainText("/admin/workspace");
      await admin.page.getByTestId("setup-banner").click();
      await expect(admin.page).toHaveURL(/\/admin\/workspace\?setup=1$/);
      const dialog = admin.page.getByTestId("onboarding-dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: "Connect DocMyRepos to GitHub" }),
      ).toBeVisible();
      await expect(dialog).toContainText("Test GitHub connection");
      await expect(dialog).toContainText("/api/sync");
      await expectAxeClean(admin.page, "onboarding dialog");

      // Start setup closes it and puts the cursor in the first field.
      await dialog.getByTestId("onboarding-start").click();
      await expect(dialog).toBeHidden();
      await expect(admin.page.getByLabel("App ID")).toBeFocused();

      // The admin home carries the banner too; without ?setup=1 the page has no pop-up.
      await admin.page.goto("/admin");
      await expect(admin.page.getByTestId("setup-banner")).toBeVisible();
      await admin.page.goto("/admin/workspace");
      await expect(admin.page.getByTestId("onboarding-dialog")).toBeHidden();

      // The info button next to the title opens the instructions again, on request.
      await admin.page.getByRole("button", { name: "Setup instructions" }).click();
      await expect(admin.page.getByTestId("onboarding-dialog")).toBeVisible();
      await expect(admin.page.getByTestId("setup-guide-webhook-url")).toHaveText(
        `${BASE}/api/webhooks/github`,
      );
      await expectAxeClean(admin.page, "setup instructions opened from the info button");
      await admin.page.keyboard.press("Escape");
      await expect(admin.page.getByTestId("onboarding-dialog")).toBeHidden();

      // The old addresses still work.
      await admin.page.goto("/admin/github");
      await expect(admin.page).toHaveURL(/\/admin\/workspace$/);
      await admin.page.goto("/admin/ask");
      await expect(admin.page).toHaveURL(/\/admin\/workspace\?tab=ask$/);
      await expect(admin.page.getByTestId("tab-ask")).toHaveAttribute("aria-selected", "true");

      await admin.page.goto("/status");
      await expect(admin.page.getByTestId("status-workspace-state")).toHaveText("Needs attention");
      await expect(admin.page.getByTestId("status-workspace-detail")).toContainText(
        "the GitHub App ID, the installation ID, the GitHub App private key",
      );
      await admin.page.goto("/admin");
      await expect(admin.page.getByTestId("admin-setup-state")).toContainText("Needs attention");
    } finally {
      await admin.close();
    }

    expect((await webhook(request, "any-secret-at-all-0123456789", "push")).status()).toBe(401);
    const sync = await request.post(`${BASE}/api/sync`, {
      headers: { authorization: `Bearer ${SYNC_SECRET}` },
    });
    expect(sync.status()).toBe(500);
    expect(await sync.json()).toMatchObject({ error: "misconfigured" });
    expect(await githubRequests(request)).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`the setup pop-up: axe, targets and fit at phone width (${theme})`, async ({
      browser,
    }) => {
      const phone = await openSession(browser, {
        stack: "settings",
        theme,
        viewport: { width: 320, height: 640 },
        textSize: "largest",
      });
      try {
        await phone.page.goto("/admin/workspace?setup=1");
        const dialog = phone.page.getByTestId("onboarding-dialog");
        await expect(dialog).toBeVisible();
        await expectAxeClean(phone.page, `onboarding dialog ${theme} phone`);
        await expectTargets(dialog, `onboarding dialog ${theme} phone`);
        await expectFits(phone.page, dialog, `onboarding dialog ${theme} phone`);
      } finally {
        await phone.close();
      }
    });
  }
});

test.describe("entering the GitHub App", () => {
  test("tests and saves it; secrets are write-only and encrypted at rest", async ({
    browser,
    request,
  }) => {
    const admin = await openSession(browser, { stack: "settings" });
    try {
      await admin.page.goto("/admin/workspace");
      await expect(admin.page.getByTestId("settings-private-key-state")).toHaveText("Not set.");
      await fillGithub(admin.page, WEBHOOK);

      await admin.page.getByRole("button", { name: "Test GitHub connection" }).click();
      await expect(admin.page.getByTestId("settings-result")).toHaveText(
        "Test passed: the installation can access 2 repositories.",
      );
      // A test saves nothing.
      expect(await dump()).not.toContain(WEBHOOK);
      expect(await dump()).toBe("[]");

      await admin.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(admin.page.getByTestId("settings-result")).toContainText("Saved.");
      await expect(admin.page.getByTestId("settings-private-key-state")).toContainText(
        "Set, changed",
      );
      // The typed secrets are gone from the form, and a reload shows nothing but "set".
      await expect(admin.page.getByLabel("Private key (PEM)")).toHaveValue("");
      await admin.page.reload();
      await expect(admin.page.getByTestId("settings-webhook-secret-state")).toContainText(
        "Set, changed",
      );
      await expect(admin.page.getByLabel("Webhook secret")).toHaveValue("");
      const html = await admin.page.content();
      for (const secret of [KEY_BODY, WEBHOOK]) expect(html).not.toContain(secret);

      // The API answers the same way: set or not, never the value.
      const response = await admin.page.request.get(`${BASE}/api/admin/settings`);
      const text = await response.text();
      for (const secret of [KEY_BODY, WEBHOOK]) expect(text).not.toContain(secret);
      expect(JSON.parse(text).secrets.github_private_key.set).toBe(true);

      // At rest: no clear text anywhere in the settings tables.
      const stored = await dump();
      for (const secret of [KEY_BODY, WEBHOOK, "PRIVATE KEY"]) expect(stored).not.toContain(secret);
      expect(stored).toContain("secret:github_private_key");

      // Nothing GitHub-related is missing any more. (A developer's own leftover config file may
      // still be reported as ignored, so the overall state is not asserted.)
      await admin.page.goto("/status");
      await expect(admin.page.getByTestId("status-workspace")).toBeVisible();
      await expect(admin.page.locator("main")).not.toContainText("Enter the GitHub App ID");
      await expect(admin.page.locator("main")).not.toContainText(
        "private key on the Workspace configuration",
      );
    } finally {
      await admin.close();
    }
    void request;
  });

  test("a sync runs with the saved settings, and a signed webhook is accepted", async ({
    browser,
    request,
  }) => {
    const sync = await request.post(`${BASE}/api/sync`, {
      headers: { authorization: `Bearer ${SYNC_SECRET}` },
    });
    expect(sync.status(), await sync.text()).toBe(200);
    expect((await githubRequests(request)).length).toBeGreaterThan(0);

    const reader = await openSession(browser, { stack: "settings" });
    try {
      await reader.page.goto("/");
      await expect(reader.page.getByTestId("repo-card").first()).toBeVisible();
      await expect(reader.page.getByText("field-guide").first()).toBeVisible();
    } finally {
      await reader.close();
    }

    expect((await webhook(request, WEBHOOK)).status()).toBe(200);
    expect((await webhook(request, "wrong-secret-0123456789abcdef")).status()).toBe(401);
  });

  test("a replaced webhook secret applies to the next delivery, with no restart", async ({
    browser,
    request,
  }) => {
    const admin = await openSession(browser, { stack: "settings" });
    try {
      await admin.page.goto("/admin/workspace");
      await admin.page.getByLabel("Webhook secret").fill(NEW_WEBHOOK);
      await admin.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(admin.page.getByTestId("settings-result")).toContainText("Saved.");
    } finally {
      await admin.close();
    }
    expect((await webhook(request, WEBHOOK)).status()).toBe(401);
    expect((await webhook(request, NEW_WEBHOOK)).status()).toBe(200);
    const stored = await dump();
    for (const secret of [WEBHOOK, NEW_WEBHOOK]) expect(stored).not.toContain(secret);
  });

  test("clearing the webhook secret makes webhooks unauthorized again", async ({
    browser,
    request,
  }) => {
    const admin = await openSession(browser, { stack: "settings" });
    try {
      await admin.page.goto("/admin/workspace");
      await admin.page
        .getByTestId("settings-webhook-secret")
        .getByLabel("Clear this value when I save")
        .check();
      await admin.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(admin.page.getByTestId("settings-webhook-secret-state")).toHaveText("Not set.");
    } finally {
      await admin.close();
    }
    expect((await webhook(request, NEW_WEBHOOK)).status()).toBe(401);
  });

  test("a change made elsewhere is reported instead of being overwritten", async ({ browser }) => {
    const a = await openSession(browser, { stack: "settings" });
    const b = await openSession(browser, { stack: "settings" });
    try {
      await a.page.goto("/admin/workspace");
      await b.page.goto("/admin/workspace");

      await a.page.getByLabel("Full sync every (minutes)").fill("30");
      await a.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(a.page.getByTestId("settings-result")).toContainText("Saved.");

      await b.page.getByLabel("Full sync every (minutes)").fill("15");
      await b.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(b.page.getByTestId("settings-result")).toContainText("changed since you opened");
      await expect(b.page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

      await b.page.getByRole("button", { name: "Reload" }).click();
      await expect(b.page.getByLabel("Full sync every (minutes)")).toHaveValue("30");
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("an invalid value is refused with the field named, and nothing is saved", async ({
    browser,
  }) => {
    const admin = await openSession(browser, { stack: "settings" });
    try {
      await admin.page.goto("/admin/workspace");
      await admin.page.getByLabel("Largest document (bytes)").fill("5");
      await admin.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(admin.page.getByTestId("settings-problems")).toContainText(
        "limits.maxFileBytes",
      );
      await admin.page.reload();
      await expect(admin.page.getByLabel("Largest document (bytes)")).toHaveValue("262144");
    } finally {
      await admin.close();
    }
  });
});

test.describe("provider credentials and Ask", () => {
  test("Ask appears once the provider is set up and disappears at once when it is cleared", async ({
    browser,
  }) => {
    const admin = await openSession(browser, { stack: "settings" });
    try {
      await admin.page.goto("/admin/ask");
      const options = admin.page.getByLabel("Provider").locator("option");
      await expect(options.nth(2)).toHaveText(
        "OpenAI-compatible endpoint (missing: OpenAI-compatible base URL)",
      );

      await admin.page.getByLabel("OpenAI-compatible base URL").fill(`${fakeProviderUrl}/v1`);
      await admin.page.getByRole("button", { name: "Save credentials" }).click();
      await expect(admin.page.getByTestId("ask-credential-result")).toHaveText(
        "Credentials saved. The next question uses them.",
      );
      await expect(options.nth(2)).toHaveText("OpenAI-compatible endpoint (configured, 127.0.0.1)");

      await admin.page.getByLabel("Provider").selectOption("openai-compatible");
      await admin.page.getByLabel("Model name").fill("fake-model-settings");
      await admin.page.getByRole("switch", { name: "Turn Ask on" }).check();
      await admin.page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(admin.page.getByTestId("ask-admin-result")).toHaveText("Saved. Ask is on.");

      await admin.page.goto("/");
      await expect(admin.page.getByTestId("ask-orb")).toBeVisible();

      // Clearing the endpoint takes effect on the very next request.
      await admin.page.goto("/admin/ask");
      await admin.page.getByLabel("OpenAI-compatible base URL").fill("");
      await admin.page.getByRole("button", { name: "Save credentials" }).click();
      await expect(admin.page.getByTestId("ask-credential-result")).toContainText(
        "Credentials saved.",
      );
      await admin.page.goto("/");
      await expect(admin.page.getByTestId("ask-orb")).toHaveCount(0);
      expect((await admin.page.goto("/ask"))?.status()).toBe(404);
      await admin.page.goto("/status");
      await expect(admin.page.getByTestId("status-ask-state")).toHaveText("Unavailable");
      await expect(admin.page.getByTestId("status-ask-detail")).toContainText(
        "OpenAI-compatible base URL",
      );
    } finally {
      await admin.close();
    }
  });

  test("an API key is write-only and encrypted too", async ({ browser }) => {
    const KEY = "sk-ant-e2e-SENTINEL-1234567890";
    const admin = await openSession(browser, { stack: "settings" });
    try {
      await admin.page.goto("/admin/ask");
      await admin.page.getByLabel("Anthropic API key").fill(KEY);
      await admin.page.getByRole("button", { name: "Save credentials" }).click();
      await expect(admin.page.getByTestId("ask-credential-result")).toContainText(
        "Credentials saved.",
      );
      await expect(admin.page.getByTestId("ask-anthropic-key-state")).toContainText("Set, changed");
      await admin.page.reload();
      expect(await admin.page.content()).not.toContain(KEY);
      expect(await (await admin.page.request.get(`${BASE}/api/admin/ask`)).text()).not.toContain(
        KEY,
      );
      expect(await dump()).not.toContain(KEY);
    } finally {
      await admin.close();
    }
  });
});

test.describe("layout and accessibility", () => {
  const PHONE = { viewport: { width: 320, height: 640 }, textSize: "largest" } as const;

  for (const theme of ["light", "dark"] as const) {
    test(`the GitHub page and the Ask credentials: axe, targets and fit (${theme})`, async ({
      browser,
    }) => {
      const desktop = await openSession(browser, { stack: "settings", theme });
      try {
        await desktop.page.goto("/admin/workspace");
        await expect(desktop.page.getByLabel("App ID")).toBeVisible();
        await expectAxeClean(desktop.page, `GitHub settings ${theme}`);
        await expectTargets(desktop.page.locator("main"), `GitHub settings ${theme}`);

        // With the repository list, problems and a result showing.
        await desktop.page.getByLabel("Only these repositories").check();
        await desktop.page.getByLabel("Repositories to show").fill("a color=red");
        await desktop.page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(desktop.page.getByTestId("settings-problems")).toBeVisible();
        await expectAxeClean(desktop.page, `GitHub settings with problems ${theme}`);

        await desktop.page.goto("/admin/ask");
        await expect(desktop.page.getByLabel("Anthropic API key")).toBeVisible();
        await expectAxeClean(desktop.page, `Ask credentials ${theme}`);
        await expectTargets(desktop.page.locator("main"), `Ask credentials ${theme}`);

        await desktop.page.goto("/admin");
        await expectAxeClean(desktop.page, `admin home ${theme}`);
        await desktop.page.goto("/status");
        await expectAxeClean(desktop.page, `status ${theme}`);
      } finally {
        await desktop.close();
      }

      const phone = await openSession(browser, { stack: "settings", theme, ...PHONE });
      try {
        for (const path of ["/admin/workspace", "/admin/ask", "/admin"]) {
          await phone.page.goto(path);
          await expect(phone.page.locator("main")).toBeVisible();
          await expectFits(phone.page, phone.page.locator("main"), `${path} ${theme} phone`);
          await expectTargets(phone.page.locator("main"), `${path} ${theme} phone`);
        }
      } finally {
        await phone.close();
      }
    });
  }
});
