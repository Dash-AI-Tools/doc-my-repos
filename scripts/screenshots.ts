/**
 * Generates the README screenshots (task 13.4): `pnpm screenshots`.
 *
 * Reuses the e2e stack: creates a throwaway database on the Postgres server of `DATABASE_URL_E2E`
 * (default: the compose database, `pnpm db:up`), migrates and seeds it with `e2e/support/seed-data.ts`
 * through the real persistence path, builds the app, serves the production build on port 3110 and
 * drives Chromium over it. GitHub is never contacted and no real credential is used.
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
import { seedDatabase } from "../e2e/support/seed";
import { databaseName, databaseUrl, runId, serverEnv, workDir } from "../e2e/support/stack";
import { createDb } from "../packages/server/src/db/client";
import { runMigrations } from "../packages/server/src/db/migrate";
import { repos, syncRuns } from "../packages/server/src/db/schema";

const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "docs-assets/screenshots");
const PORT = 3110;
const BASE = `http://127.0.0.1:${PORT}`;
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
];

function log(message: string): void {
  console.log(`[screenshots] ${message}`);
}

async function waitForServer(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("the app server exited before it was ready");
    try {
      const response = await fetch(`${BASE}/api/status`);
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
    await handle.db.delete(repos).where(inArray(repos.name, HIDDEN_REPOS));
    // Pin "last synced" to a fixed distance from now (the time shown is relative to the read).
    await handle.db
      .update(repos)
      .set({ lastSyncedAt: sql`date_trunc('hour', now()) - interval '2 hours 30 minutes'` })
      .where(isNotNull(repos.lastSyncedAt));
    await handle.db.update(syncRuns).set({
      startedAt: sql`date_trunc('hour', now()) - interval '2 hours 31 minutes'`,
      finishedAt: sql`date_trunc('hour', now()) - interval '2 hours 30 minutes'`,
    });
  } finally {
    await handle.close();
  }
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
      await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
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
  let browser: Browser | undefined;
  const dbName = databaseName("seeded");
  let created = false;
  try {
    log("seeding a throwaway database");
    created = true;
    await prepareDatabase();

    if (!skipBuild) {
      log("building the app");
      const build = spawnSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit" });
      if (build.status !== 0) throw new Error("pnpm build failed");
    }

    log(`starting the production server on ${BASE}`);
    server = spawn(
      "pnpm",
      ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)],
      {
        cwd: ROOT,
        env: { ...process.env, ...serverEnv("seeded") },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    await waitForServer(server);

    browser = await chromium.launch();
    await capture(browser, shots);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
    if (created) await dropDatabase(dbName).catch(() => log(`could not drop ${dbName}`));
    const dir = process.env.E2E_WORK_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "screenshots failed");
  process.exit(1);
});
