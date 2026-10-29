import type { Page } from "@playwright/test";

import { ASK_LAB } from "./support/ask-data";
import { queries, resetProvider, script } from "./support/ask";
import { expect, test } from "./support/csp";
import { expectAxeClean, expectFits } from "./support/layout";
import {
  adminWrite,
  anonymous,
  clearPublic,
  ensureFolder,
  setRepoFolder,
  setRepoPublic,
  signedIn,
} from "./support/public-access";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Public access, end to end (public-access tasks 2.3, 3.2, 5.4, 6.1, 7.3 and 8.1), on the
 * `publicaccess` server: no auth bypass, so the proxy and the page guards run as in
 * production and a context with no cookie is a real anonymous visitor. The leak matrix over every
 * page, API and image is a contract test (`tests/contract/public-access.test.ts`); this file
 * covers what a visitor sees and does in a browser.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);
test.use({ baseURL: stackUrl("publicaccess") });
test.describe.configure({ mode: "serial" });

const OPEN = SEEDED.full; // acme/api-service
const CLOSED = SEEDED.private; // acme/internal-tools
const OPEN_DOC = "/acme/api-service/docs/guides/setup";
const COMMENTED_DOC = "/acme/api-service/docs/reference/endpoints";
const label = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
const header = (page: Page) => page.getByRole("banner");
const signInLink = (page: Page) => header(page).getByRole("link", { name: "Sign in" });

/** Resets the workspace to "nothing public, defaults" through a signed-in admin. */
test.beforeEach(async ({ browser }) => {
  const admin = await signedIn(browser, "admin");
  try {
    await clearPublic(admin.context.request);
    await adminWrite(admin.context.request, "PUT", "/api/admin/public-access", {
      searchEnabled: true,
      askEnabled: false,
      askQuestionsPerDay: 200,
      askQuestionsPerTenMinutes: 20,
    });
  } finally {
    await admin.close();
  }
});

async function withAdmin<T>(
  browser: Parameters<typeof signedIn>[0],
  run: (request: import("@playwright/test").APIRequestContext) => Promise<T>,
): Promise<T> {
  const admin = await signedIn(browser, "admin");
  try {
    return await run(admin.context.request);
  } finally {
    await admin.close();
  }
}

test("with nothing public, every page and API is as before: sign in, or 401", async ({
  browser,
}) => {
  const visitor = await anonymous(browser);
  try {
    for (const path of ["/", "/search?q=setup", "/ask", "/acme/api-service", OPEN_DOC]) {
      await visitor.page.goto(path);
      await expect(visitor.page, path).toHaveURL(/\/login$/, { timeout: 20_000 });
    }
    for (const path of [
      "/api/search?q=setup",
      "/api/status",
      "/api/comments",
      "/api/admin/repos",
    ]) {
      expect((await visitor.context.request.get(path)).status(), path).toBe(401);
    }
    const asked = await visitor.context.request.post("/api/ask", {
      headers: { Origin: stackUrl("publicaccess") },
      data: { question: "hello" },
    });
    expect(asked.status()).toBe(401);
  } finally {
    await visitor.close();
  }
});

test("a public repository is readable without signing in, with a Sign in button and nothing else of the portal", async ({
  browser,
}) => {
  await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
  const visitor = await anonymous(browser);
  try {
    const { page } = visitor;
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(OPEN.name) })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(CLOSED.name) })).toHaveCount(0);
    await expect(signInLink(page)).toBeVisible();
    // No account menu, no status link, no admin entry.
    await expect(header(page).getByRole("button", { name: /@/ })).toHaveCount(0);
    await expect(page.getByTestId("footer-status-link")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Admin|Workspace|Users/ })).toHaveCount(0);

    await signInLink(page).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  } finally {
    await visitor.close();
  }
});

test("a public document renders like a signed-in reader's, with no comments", async ({
  browser,
}) => {
  await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
  const member = await signedIn(browser, "member");
  const visitor = await anonymous(browser);
  try {
    await member.page.goto(COMMENTED_DOC);
    await visitor.page.goto(COMMENTED_DOC);
    const article = (page: Page) => page.getByTestId("doc-article");
    await expect(article(visitor.page)).toBeVisible();
    // The same text, except the comment count that only a signed-in reader gets.
    const text = async (page: Page) =>
      (await article(page).innerText())
        .split("\n")
        .filter((line) => !/^\d+ comments?$/.test(line.trim()))
        .join("\n");
    expect(await article(member.page).innerText()).toMatch(/\d+ comments?/);
    expect(await text(visitor.page)).toBe(await text(member.page));
    expect(await article(visitor.page).innerText()).not.toMatch(/\d+ comments?/);
    // The signed-in reader has the comments of this document; the visitor sees none of it.
    await expect(member.page.getByTestId("comments-section")).toBeVisible();
    await expect(visitor.page.getByTestId("comments-section")).toHaveCount(0);
    await expect(signInLink(visitor.page)).toBeVisible();
    await expect(visitor.page.getByRole("link", { name: "Ask" })).toHaveCount(0);
  } finally {
    await member.close();
    await visitor.close();
  }
});

test("a repository that is not public cannot be told from one that does not exist", async ({
  browser,
}) => {
  await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
  const visitor = await anonymous(browser);
  try {
    for (const path of [
      `/${label(CLOSED)}`,
      `/${label(CLOSED)}/docs/index`,
      "/acme/no-such-repo",
      "/acme/no-such-repo/docs/index",
      `/${label(SEEDED.apiReference)}/api-reference/openapi.yaml`,
    ]) {
      const response = await visitor.page.goto(path);
      expect(visitor.page.url(), path).toMatch(/\/login$/);
      expect(response?.status(), path).toBe(200);
    }
    // An image of a repository that is not public is the same 404 as one that does not exist.
    const closed = await visitor.context.request.get(`/api/asset/${label(CLOSED)}/docs/x.png`);
    const missing = await visitor.context.request.get("/api/asset/acme/no-such-repo/docs/x.png");
    expect(closed.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await closed.text()).toBe(await missing.text());
    for (const response of [closed, missing]) {
      expect(response.headers()["cache-control"] ?? "no-store").not.toMatch(/public/);
    }
  } finally {
    await visitor.close();
  }
});

test("the signed-in pages and APIs stay behind the login, even with public content", async ({
  browser,
}) => {
  await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
  const visitor = await anonymous(browser);
  try {
    for (const path of ["/status", "/admin/users", "/admin/workspace", "/account/agent-access"]) {
      await visitor.page.goto(path);
      await expect(visitor.page, path).toHaveURL(/\/login$/, { timeout: 20_000 });
    }
    for (const path of ["/api/status", "/api/comments?repo=acme/api-service", "/api/admin/repos"]) {
      expect((await visitor.context.request.get(path)).status(), path).toBe(401);
    }
    const write = await visitor.context.request.post("/api/comments", {
      headers: { Origin: stackUrl("publicaccess") },
      data: { repo: label(OPEN), path: "docs/guides/setup.md", body: "hello" },
    });
    expect(write.status()).toBe(401);
  } finally {
    await visitor.close();
  }
});

test("a public folder is shown with its repositories, and a non-public folder is never named", async ({
  browser,
}) => {
  const names = await withAdmin(browser, async (request) => {
    const openFolder = await ensureFolder(request, "Open source", true);
    const closedFolder = await ensureFolder(request, "Internal secrets", false);
    await setRepoFolder(request, SEEDED.okf, openFolder);
    await setRepoFolder(request, OPEN, closedFolder);
    await setRepoPublic(request, OPEN, true);
    return { openFolder, closedFolder };
  });
  const visitor = await anonymous(browser);
  try {
    await visitor.page.goto("/");
    await expect(visitor.page.getByRole("region", { name: /^Open source/ })).toBeVisible();
    await expect(
      visitor.page.getByRole("link", { name: new RegExp(SEEDED.okf.name) }),
    ).toBeVisible();
    // The public repository of the non-public folder is listed, but the folder is not.
    await expect(visitor.page.getByRole("link", { name: new RegExp(OPEN.name) })).toBeVisible();
    expect(await visitor.page.content()).not.toContain("Internal secrets");
  } finally {
    await visitor.close();
    await withAdmin(browser, async (request) => {
      await setRepoFolder(request, SEEDED.okf, null);
      await setRepoFolder(request, OPEN, null);
      await adminWrite(request, "PATCH", `/api/admin/folders/${names.openFolder}`, {
        isPublic: false,
      });
    });
  }
});

test("anonymous search covers the public repositories only, and can be turned off", async ({
  browser,
}) => {
  await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
  const visitor = await anonymous(browser);
  try {
    const { page } = visitor;
    await page.goto("/search?q=setup");
    const results = page.getByTestId("search-results");
    await expect(results).toBeVisible();
    const hrefs = await results
      .getByRole("link")
      .evaluateAll((links) =>
        links.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""),
      );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith("/acme/api-service"), href).toBe(true);
    const api = await visitor.context.request.get("/api/search?q=setup");
    expect(api.status()).toBe(200);
    expect(JSON.stringify(await api.json())).not.toContain("internal-tools");

    await withAdmin(browser, (request) =>
      adminWrite(request, "PUT", "/api/admin/public-access", { searchEnabled: false }),
    );
    await page.goto("/");
    await expect(header(page).getByRole("link", { name: "Search" })).toHaveCount(0);
    await page.goto("/search?q=setup");
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
    expect((await visitor.context.request.get("/api/search?q=setup")).status()).toBe(401);
  } finally {
    await visitor.close();
  }
});

test.describe("anonymous Ask", () => {
  const BASE = stackUrl("publicaccess");
  const SIGNING = "How do I rotate the signing key?";

  async function turnAskOn(browser: Parameters<typeof signedIn>[0], perTenMinutes = 20) {
    await withAdmin(browser, async (request) => {
      await setRepoPublic(request, ASK_LAB, true);
      const saved = await adminWrite(request, "PUT", "/api/admin/ask", {
        enabled: true,
        provider: "openai-compatible",
        model: "test-model",
      });
      expect(saved.status(), await saved.text()).toBe(200);
      await adminWrite(request, "PUT", "/api/admin/public-access", {
        askEnabled: true,
        askQuestionsPerTenMinutes: perTenMinutes,
      });
    });
  }

  test.afterEach(async ({ browser }) => {
    await withAdmin(browser, (request) =>
      adminWrite(request, "PUT", "/api/admin/ask", { enabled: false }),
    );
  });

  test("stops at the shared cap with a retry time, and signed-in users are not affected", async ({
    browser,
    request,
  }) => {
    await resetProvider(request);
    await script(request, {
      query: queries("rotate signing key"),
      answer: { kind: "text", chunks: ["Run `keys rotate` ", "to rotate it [1]."] },
    });
    // First of the Ask tests, so no anonymous question has been counted yet (anonymous rows cannot
    // be removed): a cap of 1 leaves room for exactly one.
    await turnAskOn(browser, 1);
    const visitor = await anonymous(browser);
    const other = await anonymous(browser);
    const member = await signedIn(browser, "member");
    try {
      const ask = async (page: Page) => {
        await page.goto("/ask");
        await page.getByLabel("Your question").fill(SIGNING);
        await page.getByRole("button", { name: "Ask", exact: true }).click();
      };
      await ask(visitor.page);
      await expect(visitor.page.getByTestId("ask-exchange").last()).toHaveAttribute(
        "data-status",
        "done",
        { timeout: 30_000 },
      );
      // A different anonymous visitor shares the cap, so they are refused.
      await ask(other.page);
      await expect(other.page.getByTestId("ask-exchange").last()).toHaveAttribute(
        "data-status",
        "error",
        { timeout: 30_000 },
      );
      await expect(other.page.getByTestId("ask-notice").last()).toContainText(
        /question limit|ask again/i,
      );
      // A signed-in user has their own limit.
      await ask(member.page);
      await expect(member.page.getByTestId("ask-exchange").last()).toHaveAttribute(
        "data-status",
        "done",
        { timeout: 30_000 },
      );
    } finally {
      await visitor.close();
      await other.close();
      await member.close();
    }
  });

  test("is offered only when allowed, and answers from public repositories with references", async ({
    browser,
    request,
  }) => {
    await resetProvider(request);
    await script(request, {
      query: queries("rotate signing key"),
      answer: { kind: "text", chunks: ["Run `keys rotate` ", "to rotate it [1]."] },
    });
    const visitor = await anonymous(browser);
    try {
      const { page } = visitor;
      // Ask is on for members but anonymous Ask is off: no link, and /ask asks to sign in.
      await withAdmin(browser, async (admin) => {
        await setRepoPublic(admin, ASK_LAB, true);
        await adminWrite(admin, "PUT", "/api/admin/ask", {
          enabled: true,
          provider: "openai-compatible",
          model: "test-model",
        });
      });
      await page.goto(`/${label(ASK_LAB)}`);
      await expect(header(page).getByRole("link", { name: "Ask" })).toHaveCount(0);
      await page.goto("/ask");
      await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });

      await turnAskOn(browser);
      await page.goto(`/${label(ASK_LAB)}`);
      await expect(header(page).getByRole("link", { name: "Ask" })).toBeVisible();
      await expect(signInLink(page)).toBeVisible();
      await page.goto("/ask");
      await expect(page.getByRole("heading", { level: 1, name: "Ask the docs" })).toBeVisible();
      await page.getByLabel("Your question").fill(SIGNING);
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await expect(page.getByTestId("ask-exchange").last()).toHaveAttribute("data-status", "done", {
        timeout: 30_000,
      });
      const exchange = page.getByTestId("ask-exchange");
      await expect(exchange.getByTestId("ask-answer")).toContainText("to rotate it");
      await expect(
        exchange.getByRole("link", { name: /^Signing keys, section Rotate the signing key/ }),
      ).toHaveAttribute("href", "/acme/ask-lab/docs/guides/signing-keys#rotate-the-signing-key");
    } finally {
      await visitor.close();
    }
    void BASE;
  });
});

for (const theme of ["light", "dark"] as const) {
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 375, height: 700 }],
  ] as const) {
    test(`the anonymous pages have no accessibility violations (${theme}, ${name})`, async ({
      browser,
    }) => {
      await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
      const visitor = await anonymous(browser, { theme, viewport });
      try {
        const { page } = visitor;
        await page.goto("/");
        await expect(signInLink(page)).toBeVisible();
        await expectAxeClean(page, `public home (${theme}, ${name})`);
        await expectFits(page, page.locator("main"), `public home (${theme}, ${name})`);
        await page.goto(OPEN_DOC);
        await expect(page.getByTestId("doc-article")).toBeVisible();
        await expectAxeClean(page, `public document (${theme}, ${name})`);
        await page.goto("/search?q=setup");
        await expect(page.getByTestId("search-results").first()).toBeVisible();
        await expectAxeClean(page, `public search (${theme}, ${name})`);
      } finally {
        await visitor.close();
      }
    });
  }
}

test("the Sign in link is reachable by keyboard and large enough to tap", async ({ browser }) => {
  await withAdmin(browser, (request) => setRepoPublic(request, OPEN, true));
  const visitor = await anonymous(browser, { viewport: { width: 375, height: 700 } });
  try {
    await visitor.page.goto("/");
    const link = signInLink(visitor.page);
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await link.focus();
    await expect(link).toBeFocused();
    await visitor.page.keyboard.press("Enter");
    await expect(visitor.page).toHaveURL(/\/login$/, { timeout: 20_000 });
  } finally {
    await visitor.close();
  }
});

test.describe("admin controls", () => {
  const PRIVATE = SEEDED.private; // acme/internal-tools, private on GitHub
  const label = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
  const publicSwitch = (page: Page, name: string) =>
    page.getByRole("switch", { name: `Public access for ${name}` });

  async function openRepos(page: Page): Promise<void> {
    await page.goto("/admin/workspace?tab=repos");
    await expect(
      page.getByRole("tab", { name: "Repository access", selected: true }),
    ).toBeVisible();
  }

  test("an admin turns a repository public from its row, and it stays public after a reload", async ({
    browser,
  }) => {
    const admin = await signedIn(browser, "admin");
    try {
      await openRepos(admin.page);
      const toggle = publicSwitch(admin.page, label(OPEN));
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(
        admin.page.getByText(`${label(OPEN)} is public: anyone can read it without signing in.`),
      ).toBeVisible();
      await admin.page.reload();
      await expect(publicSwitch(admin.page, label(OPEN))).toBeChecked();
      await publicSwitch(admin.page, label(OPEN)).click();
      await expect(
        admin.page.getByText(`${label(OPEN)} is no longer public on its own.`),
      ).toBeVisible();
      await admin.page.reload();
      await expect(publicSwitch(admin.page, label(OPEN))).not.toBeChecked();
    } finally {
      await admin.close();
    }
  });

  test("a repository that is private on GitHub asks for a confirmation, and cancelling changes nothing", async ({
    browser,
  }) => {
    const admin = await signedIn(browser, "admin");
    try {
      await openRepos(admin.page);
      await publicSwitch(admin.page, label(PRIVATE)).click();
      const alert = admin.page.getByRole("alert").filter({ hasText: "private on GitHub" });
      await expect(alert).toBeVisible();
      await expect(publicSwitch(admin.page, label(PRIVATE))).not.toBeChecked();
      await alert.getByRole("button", { name: "Cancel" }).click();
      await expect(alert).toHaveCount(0);
      await admin.page.reload();
      await expect(publicSwitch(admin.page, label(PRIVATE))).not.toBeChecked();

      await publicSwitch(admin.page, label(PRIVATE)).click();
      await admin.page
        .getByRole("alert")
        .filter({ hasText: "private on GitHub" })
        .getByRole("button", { name: "Confirm and make public" })
        .click();
      await expect(admin.page.getByText(`${label(PRIVATE)} is public`)).toBeVisible();
      await admin.page.reload();
      await expect(publicSwitch(admin.page, label(PRIVATE))).toBeChecked();
    } finally {
      await admin.close();
    }
  });

  test("a folder is turned public from the Folders tab, with a note and a confirmation for private repositories", async ({
    browser,
  }) => {
    const admin = await signedIn(browser, "admin");
    try {
      const request = admin.context.request;
      const folderId = await ensureFolder(request, "Mixed folder", false);
      for (const repo of [OPEN, PRIVATE]) {
        const moved = await adminWrite(request, "PATCH", "/api/admin/repos", { ...repo, folderId });
        expect(moved.ok()).toBe(true);
      }
      await admin.page.goto("/admin/workspace?tab=folders");
      const toggle = publicSwitch(admin.page, "Mixed folder");
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      const alert = admin.page.getByRole("alert").filter({ hasText: "private on GitHub" });
      await expect(alert).toContainText("1 repository that is private on GitHub");
      await alert.getByRole("button", { name: "Confirm and make public" }).click();
      await expect(admin.page.getByText("Mixed folder is public")).toBeVisible();
      await admin.page.reload();
      await expect(publicSwitch(admin.page, "Mixed folder")).toBeChecked();
      await expect(
        admin.page.getByText(/Holds 1 repository private on\s+GitHub, readable by anyone/),
      ).toBeVisible();
      for (const repo of [OPEN, PRIVATE]) {
        await adminWrite(request, "PATCH", "/api/admin/repos", { ...repo, folderId: null });
      }
      await adminWrite(request, "PATCH", `/api/admin/folders/${folderId}`, { isPublic: false });
    } finally {
      await admin.close();
    }
  });

  test("a signed-in non-admin cannot change public access", async ({ browser }) => {
    const member = await signedIn(browser, "member");
    try {
      const repo = await adminWrite(member.context.request, "PATCH", "/api/admin/repos", {
        ...OPEN,
        isPublic: true,
      });
      expect(repo.status()).toBe(403);
      const settings = await adminWrite(member.context.request, "PUT", "/api/admin/public-access", {
        askEnabled: true,
      });
      expect(settings.status()).toBe(403);
      expect((await member.context.request.get("/api/admin/public-access")).status()).toBe(403);
    } finally {
      await member.close();
    }
  });

  test("the Public access settings save, validate and persist", async ({ browser }) => {
    const admin = await signedIn(browser, "admin");
    try {
      await openRepos(admin.page);
      const section = admin.page.getByTestId("public-access");
      await expect(section.getByTestId("public-access-nothing")).toBeVisible();
      await expect(section.getByRole("switch", { name: "Allow search" })).toBeChecked();
      await expect(section.getByRole("switch", { name: "Allow Ask the docs" })).not.toBeChecked();
      await expect(section.getByLabel("Anonymous questions per day")).toHaveValue("200");

      await section.getByLabel("Anonymous questions per day").fill("0");
      await section.getByRole("button", { name: "Save public access" }).click();
      await expect(section.getByTestId("public-access-problem")).toContainText("from 1 to 10000");

      await section.getByRole("switch", { name: "Allow Ask the docs" }).click();
      await section.getByLabel("Anonymous questions per day").fill("30");
      await section.getByLabel("Anonymous questions per ten minutes").fill("3");
      await section.getByRole("button", { name: "Save public access" }).click();
      await expect(section.getByTestId("public-access-result")).toContainText("Saved");
      await admin.page.reload();
      const again = admin.page.getByTestId("public-access");
      await expect(again.getByRole("switch", { name: "Allow Ask the docs" })).toBeChecked();
      await expect(again.getByLabel("Anonymous questions per day")).toHaveValue("30");
      await expect(again.getByLabel("Anonymous questions per ten minutes")).toHaveValue("3");

      // Back to the defaults for the specs that follow.
      const reset = await adminWrite(admin.context.request, "PUT", "/api/admin/public-access", {
        searchEnabled: true,
        askEnabled: false,
        askQuestionsPerDay: 200,
        askQuestionsPerTenMinutes: 20,
      });
      expect(reset.ok()).toBe(true);
    } finally {
      await admin.close();
    }
  });

  for (const theme of ["light", "dark"] as const) {
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["phone", { width: 375, height: 700 }],
    ] as const) {
      test(`the admin controls have no accessibility violations (${theme}, ${name})`, async ({
        browser,
      }) => {
        const admin = await signedIn(browser, "admin", { theme, viewport });
        try {
          await ensureFolder(admin.context.request, "Axe folder", true);
          await openRepos(admin.page);
          await expect(admin.page.getByTestId("public-access")).toBeVisible();
          await expectAxeClean(admin.page, `repository access (${theme}, ${name})`);
          await admin.page.goto("/admin/workspace?tab=folders");
          await expect(publicSwitch(admin.page, "Axe folder")).toBeVisible();
          await expectAxeClean(admin.page, `folders (${theme}, ${name})`);
        } finally {
          await admin.close();
        }
      });
    }
  }
});

test.describe("leak matrix", () => {
  const BASE = stackUrl("publicaccess");

  interface RepoRow {
    owner: string;
    name: string;
    description: string | null;
  }

  test("a visitor without a session sees nothing of any repository that is not public", async ({
    browser,
  }) => {
    const admin = await signedIn(browser, "admin");
    let others: RepoRow[];
    try {
      await clearPublic(admin.context.request);
      await setRepoPublic(admin.context.request, OPEN, true);
      const all = (
        (await (await admin.context.request.get("/api/admin/repos")).json()) as {
          repos: RepoRow[];
        }
      ).repos;
      others = all.filter((r) => !(r.owner === OPEN.owner && r.name === OPEN.name));
      expect(others.length).toBeGreaterThan(5);
    } finally {
      await admin.close();
    }

    // What must never appear: each other repository's name, and its description when it has one.
    const secrets = others.flatMap((r) => [
      `${r.owner}/${r.name}`,
      r.name,
      ...(r.description && r.description.length > 12 ? [r.description] : []),
    ]);

    const visitor = await anonymous(browser);
    try {
      const request = visitor.context.request;
      const bodies: {
        path: string;
        status: number;
        body: string;
        headers: Record<string, string>;
      }[] = [];
      const fetchPath = async (path: string) => {
        const response = await request.get(path, { maxRedirects: 0 });
        bodies.push({
          path,
          status: response.status(),
          body: await response.text(),
          headers: response.headers(),
        });
      };

      // The pages of the open repository, and the search over it.
      for (const path of [
        "/",
        "/search",
        "/search?q=setup",
        "/search?q=guide&page=2",
        `/${OPEN.owner}/${OPEN.name}`,
        `/${OPEN.owner}/${OPEN.name}/docs/guides/setup`,
        `/${OPEN.owner}/${OPEN.name}/docs/reference/endpoints`,
        "/api/search?q=setup",
        "/api/search?q=guide",
        "/api/search?q=endpoints&limit=10",
      ]) {
        await fetchPath(path);
      }
      // Every other repository: its page, a document, its API reference, an image, a search for it.
      for (const r of others) {
        for (const path of [
          `/${r.owner}/${r.name}`,
          `/${r.owner}/${r.name}/docs/index`,
          `/${r.owner}/${r.name}/docs/guides/setup`,
          `/${r.owner}/${r.name}/api-reference/openapi.yaml`,
          `/api/asset/${r.owner}/${r.name}/docs/img/pic.png`,
          `/api/search?q=${encodeURIComponent(r.name)}`,
          `/api/search?q=${encodeURIComponent(r.name)}&repo=${encodeURIComponent(`${r.owner}/${r.name}`)}`,
          `/search?q=${encodeURIComponent(r.name)}`,
          `/search?q=guide&repo=${encodeURIComponent(`${r.owner}/${r.name}`)}`,
        ]) {
          await fetchPath(path);
        }
      }

      expect(bodies.length).toBeGreaterThan(60);
      for (const { path, status, body, headers } of bodies) {
        // Pages and APIs: a redirect to the sign-in page, 401 or 404, or the open repository's own
        // content. Never anything that names another repository.
        expect([200, 307, 308, 401, 404], `${path} → ${status}`).toContain(status);
        // A page may repeat the address the visitor typed, so a repository named in the request is
        // not a leak when the answer names it again; every other repository must never appear.
        const typed = decodeURIComponent(path);
        for (const secret of secrets.filter((name) => !typed.includes(name))) {
          expect(body.includes(secret), `${path} leaks "${secret}"`).toBe(false);
        }
        // No response may be stored by a shared cache: pages and answers differ by who asks.
        const cache = headers["cache-control"] ?? "";
        if (path.startsWith("/api/asset/")) expect(cache, path).not.toMatch(/public/);
        else if (status === 200) expect(cache, path).toMatch(/no-store|private/);
      }

      // The open repository itself is served, so the matrix proves a filter and not a closed door.
      const home = bodies.find((b) => b.path === "/")!;
      expect(home.status).toBe(200);
      expect(home.body).toContain(OPEN.name);
      const search = bodies.find((b) => b.path === "/api/search?q=setup")!;
      expect(search.status).toBe(200);
      expect(search.body).toContain(`${OPEN.owner}/${OPEN.name}`);

      // Hit and facet counts of a search over everything are the open repository's alone.
      const counted = JSON.parse(bodies.find((b) => b.path === "/api/search?q=guide")!.body) as {
        results?: { repo?: string }[];
      };
      for (const hit of counted.results ?? []) {
        expect(JSON.stringify(hit)).toContain(OPEN.name);
      }
      expect(BASE).toBeTruthy();
    } finally {
      await visitor.close();
    }
  });
});
