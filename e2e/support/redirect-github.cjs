/**
 * Test-only preload for the `settings` e2e server (`node --require`): sends the server's requests
 * for the GitHub API to the fake GitHub on a loopback port, so the GitHub App settings entered in
 * the admin interface can be exercised end to end without the network. The app has no setting for
 * this on purpose; nothing outside `e2e/` loads this file.
 */
const target = process.env.E2E_GITHUB_API_URL;
const real = "https://api.github.com";

if (target && typeof globalThis.fetch === "function") {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = typeof url === "string" && URL.canParse(url) ? new URL(url) : null;
    if (parsed !== null && parsed.origin === real) {
      const next = target + parsed.pathname + parsed.search;
      return original(
        typeof input === "string" || input instanceof URL ? next : new Request(next, input),
        init,
      );
    }
    return original(input, init);
  };
}
