/**
 * Switch for the e2e-only fixture pages under `src/app/e2e/` (task 7.8).
 *
 * The pages exist so Playwright can exercise client components before the real pages do. They
 * answer 404 unless `E2E_FIXTURES` is exactly `"1"` in the server's environment. Only the
 * Playwright `webServer` (playwright.config.ts) sets it. Never set it in `.env`, `.env.example`,
 * the Dockerfile or the compose file; a production deployment must not be able to reach them.
 *
 * Read per request (the pages call `connection()` first), never at build time, so the build
 * output does not depend on it.
 */
export function e2eFixturesEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.E2E_FIXTURES === "1";
}
