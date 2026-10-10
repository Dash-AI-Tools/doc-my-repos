import { defineConfig, devices } from "@playwright/test";

import { SKIP_DB, STACKS, serverEnv, stackUrl } from "./e2e/support/stack";

/**
 * End-to-end tests (tasks 7.8 and 9.2). `pnpm test:e2e` builds the app once and serves the
 * production build on four ports (see `e2e/support/stack.ts`):
 *
 * - 3100 `fixtures`: no database; the e2e-only fixture pages (`E2E_FIXTURES=1`, see
 *   `src/lib/e2e-fixtures.ts`). Outside CI a server already running on the port is reused, so you
 *   can start it yourself with the same variable for fast reruns:
 *   `E2E_FIXTURES=1 pnpm exec next start --port 3100`.
 * - 3101 `seeded`: a throwaway database filled from `e2e/support/seed-data.ts`.
 * - 3102 `empty`: a throwaway, migrated, empty database.
 * - 3103 `unreachable`: `DATABASE_URL` points at a port nothing listens on.
 *
 * The last three need Postgres (`docker compose --env-file .env.example up -d --wait db`, or
 * `DATABASE_URL_E2E` for another server). Without it the run fails loudly before the build, unless
 * `E2E_SKIP_DB=1`: then only `fixtures` and `unreachable` start and the specs that need a
 * database skip themselves with a visible reason. `e2e/support/global-setup.ts` creates, migrates
 * and seeds the databases; `global-teardown.ts` drops them. Servers 3101 to 3103 are never reused.
 *
 * Playwright starts the web servers one after the other, in this order, and before the global
 * setup, so the first command builds and the others only start. Vitest does not see `e2e/`
 * (vitest.config.ts excludes it); Playwright only reads `e2e/*.spec.ts`.
 */
const isCI = Boolean(process.env.CI);

const start = (port: number) => `pnpm exec next start --hostname 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  globalSetup: "./e2e/support/global-setup.ts",
  globalTeardown: "./e2e/support/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: stackUrl("fixtures"),
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The preflight fails in a second when Postgres is missing, before the build starts.
      command: `pnpm exec tsx e2e/support/preflight.ts && pnpm build && ${start(STACKS.fixtures.port)}`,
      url: stackUrl("fixtures"),
      reuseExistingServer: !isCI,
      timeout: 300_000,
      env: { E2E_FIXTURES: "1" },
    },
    ...(SKIP_DB
      ? []
      : (["seeded", "empty"] as const).map((name) => ({
          command: start(STACKS[name].port),
          url: stackUrl(name),
          reuseExistingServer: false,
          timeout: 60_000,
          env: serverEnv(name),
        }))),
    {
      command: start(STACKS.unreachable.port),
      url: stackUrl("unreachable"),
      reuseExistingServer: false,
      timeout: 60_000,
      env: serverEnv("unreachable"),
    },
  ],
});
