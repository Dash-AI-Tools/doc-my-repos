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

/**
 * Request header with which the e2e suite asks the root layout to crash, so `global-error.tsx`
 * can be exercised in a real browser (nothing else can make a root layout throw on demand). The
 * layout honors it only when `E2E_FIXTURES` is `"1"` (`shouldCrashRootLayout`); a production
 * server never has that variable, so a client sending the header gets a normal page.
 */
export const E2E_CRASH_HEADER = "x-e2e-crash-layout";

export function shouldCrashRootLayout(
  env: Readonly<Record<string, string | undefined>>,
  headerValue: string | null,
): boolean {
  return e2eFixturesEnabled(env) && headerValue === "1";
}
