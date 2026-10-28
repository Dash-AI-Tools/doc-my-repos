/**
 * Generates the README screenshots (task 13.4): `pnpm screenshots`.
 *
 * Reuses the e2e stack: creates a throwaway database on the Postgres server of `DATABASE_URL_E2E`
 * (default: the compose database, `pnpm db:up`), migrates and seeds it with `e2e/support/seed-data.ts`
 * through the real persistence path, builds the app, serves the production build on port 3110 and
 * drives Chromium over it. The `ask` shot uses a second throwaway database with Ask on, served on
 * port 3112, and a scripted model provider on port 3190. GitHub is never contacted, no model
 * provider is called and no real credential is used.
 *
 * Output: `docs-assets/screenshots/<name>-light.png` and `<name>-dark.png`, 1280x800 viewport.
 * Pages are the seeded demo repositories, so the images do not change unless the UI or the seed
 * data does. Relative times ("3 hours ago") are pinned to a fixed distance from the capture time.
 *
 *   pnpm screenshots                  # build, capture all
 *   pnpm screenshots -- --skip-build  # reuse the existing .next build
 *   pnpm screenshots -- home search   # only these shots
 *
 * Needs Chromium (`pnpm exec playwright install chromium`).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";
import { inArray, isNotNull, sql } from "drizzle-orm";

import { assertPostgresReachable, createDatabase, dropDatabase } from "../e2e/support/db";
import { seedAskData } from "../e2e/support/ask-seed";
import { seedDatabase } from "../e2e/support/seed";
import { seedSettings } from "../e2e/support/settings-seed";
import {
  FAKE_PROVIDER_PORT,
  databaseName,
  databaseUrl,
  runId,
  serverEnv,
  workDir,
} from "../e2e/support/stack";
import { startFakeProvider } from "../tests/support/fake-provider";
import { createDb } from "../packages/server/src/db/client";
import { runMigrations } from "../packages/server/src/db/migrate";
import { repos, syncRuns } from "../packages/server/src/db/schema";

const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "docs-assets/screenshots");
const PORT = 3110;
const BASE = `http://127.0.0.1:${PORT}`;
/** The second server, for the shots that need Ask on (a database with a model provider). */
const ASK_PORT = 3112;
const ASK_BASE = `http://127.0.0.1:${ASK_PORT}`;
const ASK_QUESTION = "How do I rotate the signing key?";
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** Edge-case repositories of the e2e seed that would only clutter a showcase. */
const HIDDEN_REPOS = [
  "brand-new",
  "flaky-service",
  "a-repository-with-a-really-long-name-for-layout-testing",
  "no-readme",
  "no-codeowners",
  "rich-readme",
  "empty-docs",
  "capped-docs",
  "handbook",
];

const PLACEHOLDER_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120"><rect width="640" height="120" rx="2" fill="#8b8b8b" fill-opacity="0.16"/><text x="320" y="66" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#8b8b8b">Image from the repository</text></svg>`;

interface Shot {
  readonly name: string;
  /** Path to open. */
  readonly path: string;
  /** Capture the whole page (taller than the 1280x800 viewport) instead of the first screen. */
  readonly fullPage?: boolean;
  /** `ask`: served by the second server, whose database has Ask on and a scripted provider. */
  readonly server?: "ask";
  /** Runs after the page loaded, before the capture: waits, clicks, typing. */
  readonly prepare?: (page: Page) => Promise<void>;
}

const SHOTS: readonly Shot[] = [
  { name: "home", path: "/" },
  { name: "repo", path: "/acme/api-service" },
  {
    name: "doc",
    path: "/acme/doc-showcase/docs/guides/getting-started",
    fullPage: true,
    prepare: async (page) => {
      await page
        .locator(".dmr-mermaid-diagram svg")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
    },
  },
  { name: "search", path: "/search?q=deployment" },
  {
    name: "palette",
    path: "/",
    prepare: async (page) => {
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Quick search" });
      await dialog.waitFor({ state: "visible" });
      await page.getByRole("combobox").pressSequentially("deployment");
      await page.getByRole("option").first().waitFor({ state: "visible" });
    },
  },
  { name: "okf-filters", path: "/acme/knowledge-base?type=Runbook&type=concept" },
  { name: "okf-metadata", path: "/acme/okf-showcase/docs/concepts/full-metadata" },
  {
    name: "api-reference",
    path: "/acme/openapi-specs/api-reference/openapi.yaml",
    prepare: async (page) => {
      await page
        .locator(".api-reference .swagger-ui .opblock")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
    },
  },
  {
    name: "workspace",
    path: "/admin/workspace",
    prepare: async (page) => {
      // Tall enough for the whole form: the Save bar is sticky, so a full-page capture would
      // draw it in the middle of the page.
      await page.setViewportSize({ width: 1280, height: 1560 });
      await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
    },
  },
  {
    name: "status",
    path: "/status",
    prepare: async (page) => {
      await page.getByTestId("status-last-run").waitFor({ state: "visible" });
    },
  },
  {
    name: "ask",
    path: "/ask",
    server: "ask",
    prepare: async (page) => {
      await page.getByLabel("Your question").fill(ASK_QUESTION);
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await page
        .getByTestId("ask-exchange")
        .last()
        .and(page.locator('[data-status="done"]'))
        .waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("ask-live").filter({ hasText: "Answer ready." }).waitFor();
    },
  },
];

function log(message: string): void {
  console.log(`[screenshots] ${message}`);
}

async function waitForServer(server: ChildProcess, base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("the app server exited before it was ready");
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the app server did not answer in 60 s");
}

async function prepareDatabase(): Promise<void> {
  const name = databaseName("seeded");
  await createDatabase(name);
  const handle = createDb(databaseUrl("seeded"), { max: 2, connectTimeoutMs: 5_000 });
  try {
    await runMigrations(handle, resolve(ROOT, "drizzle"));
    await seedDatabase(handle.db);
    // A GitHub App configured (placeholder ids), so the pages show no "Connect to GitHub" banner.
    await seedSettings(handle.db, "seeded");
    await handle.db.delete(repos).where(inArray(repos.name, HIDDEN_REPOS));
    // Pin "last synced" to a fixed distance from now (the time shown is relative to the read).
    await handle.db
      .update(repos)
      .set({ lastSyncedAt: sql`date_trunc('hour', now()) - interval '2 hours 30 minutes'` })
      .where(isNotNull(repos.lastSyncedAt));
    // The seed's run is a failure case; the showcase run is a clean one.
    await handle.db.update(syncRuns).set({
      status: "success",
      reposFailed: 0,
      startedAt: sql`date_trunc('hour', now()) - interval '2 hours 31 minutes'`,
      finishedAt: sql`date_trunc('hour', now()) - interval '2 hours 30 minutes'`,
    });
  } finally {
    await handle.close();
  }
}

/** A database like the seeded one, with Ask on and the scripted provider as its model endpoint. */
async function prepareAskDatabase(): Promise<void> {
  await createDatabase(databaseName("ask"));
  const handle = createDb(databaseUrl("ask"), { max: 2, connectTimeoutMs: 5_000 });
  try {
    await runMigrations(handle, resolve(ROOT, "drizzle"));
    await seedDatabase(handle.db);
    await seedSettings(handle.db, "ask");
    await seedAskData(handle.db);
    await handle.db.execute(
      sql`insert into ask_settings (id, enabled, provider, model)
          values (1, true, 'openai-compatible', 'demo-model')
          on conflict (id) do update set enabled = true, provider = 'openai-compatible', model = 'demo-model'`,
    );
  } finally {
    await handle.close();
  }
}

function startServer(port: number, kind: "seeded" | "ask"): ChildProcess {
  return spawn(
    "pnpm",
    ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: ROOT,
      env: { ...process.env, ...serverEnv(kind) },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

async function capture(browser: Browser, shots: readonly Shot[]): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: "reduce",
      locale: "en-GB",
      timezoneId: "UTC",
    });
    // Images of the demo documents would be fetched from GitHub by the image proxy. Answer with a
    // placeholder instead, so nothing leaves the machine.
    await context.route("**/api/asset/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: PLACEHOLDER_IMAGE }),
    );
    await context.addInitScript(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      ["docmyrepos-theme", theme satisfies Theme],
    );
    for (const shot of shots) {
      const page = await context.newPage();
      await page.goto(`${shot.server === "ask" ? ASK_BASE : BASE}${shot.path}`, {
        waitUntil: "networkidle",
      });
      await page.evaluate(() => document.fonts.ready);
      await shot.prepare?.(page);
      await page.waitForTimeout(300);
      const file = resolve(OUT_DIR, `${shot.name}-${theme}.png`);
      await page.screenshot({
        path: file,
        type: "png",
        fullPage: shot.fullPage ?? false,
        animations: "disabled",
        caret: "hide",
      });
      log(`${shot.name}-${theme}.png ${(statSync(file).size / 1024).toFixed(0)} KB`);
      await page.close();
    }
    await context.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const skipBuild = args.includes("--skip-build");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const shots = wanted.length === 0 ? SHOTS : SHOTS.filter((s) => wanted.includes(s.name));
  if (shots.length === 0)
    throw new Error(`no such shot; choose from ${SHOTS.map((s) => s.name).join(", ")}`);

  workDir();
  runId();
  await assertPostgresReachable();

  let server: ChildProcess | undefined;
  let askServer: ChildProcess | undefined;
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let browser: Browser | undefined;
  const dbName = databaseName("seeded");
  const askDbName = databaseName("ask");
  let created = false;
  let askCreated = false;
  const needsAsk = shots.some((s) => s.server === "ask");
  try {
    log("seeding a throwaway database");
    created = true;
    await prepareDatabase();
    if (needsAsk) {
      askCreated = true;
      await prepareAskDatabase();
      // The model the Ask server talks to: a scripted answer, nothing leaves the machine.
      provider = await startFakeProvider({ port: FAKE_PROVIDER_PORT });
      provider.setDefault((request) =>
        request.stream
          ? {
              kind: "text",
              chunks: [
                "Run `keys rotate` to rotate the signing key [1]. ",
                "The previous key keeps verifying tokens for 24 hours [2].",
              ],
              usage: { input: 320, output: 40 },
            }
          : { kind: "text", chunks: [JSON.stringify(["rotate signing key"])] },
      );
    }

    if (!skipBuild) {
      log("building the app");
      const build = spawnSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit" });
      if (build.status !== 0) throw new Error("pnpm build failed");
    }

    log(`starting the production server on ${BASE}`);
    server = startServer(PORT, "seeded");
    await waitForServer(server, BASE);
    if (needsAsk) {
      log(`starting the Ask server on ${ASK_BASE}`);
      askServer = startServer(ASK_PORT, "ask");
      await waitForServer(askServer, ASK_BASE);
    }

    browser = await chromium.launch();
    await capture(browser, shots);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
    askServer?.kill("SIGTERM");
    await provider?.close().catch(() => undefined);
    if (created) await dropDatabase(dbName).catch(() => log(`could not drop ${dbName}`));
    if (askCreated) await dropDatabase(askDbName).catch(() => log(`could not drop ${askDbName}`));
    const dir = process.env.E2E_WORK_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "screenshots failed");
  process.exit(1);
});
