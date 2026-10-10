import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (task 7.8). `pnpm test:e2e` builds the app and serves the production build on
 * a fixed port with the e2e-only fixture pages enabled (`E2E_FIXTURES=1`, see
 * `src/lib/e2e-fixtures.ts`). Outside CI a server already running on the port is reused, so start
 * it yourself with the same variable if you want fast reruns:
 *
 *   E2E_FIXTURES=1 pnpm exec next start --port 3100
 *
 * Vitest does not see `e2e/` (vitest.config.ts excludes it); Playwright only reads `e2e/*.spec.ts`.
 */
const PORT = 3100;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && pnpm exec next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !isCI,
    timeout: 300_000,
    env: { E2E_FIXTURES: "1" },
  },
});
