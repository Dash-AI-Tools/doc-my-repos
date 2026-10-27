import type { APIResponse, Page } from "@playwright/test";

import {
  BASELINE_HEADERS,
  HSTS_VALUE,
  buildContentSecurityPolicy,
} from "../src/lib/security-headers";
import { PNG, stubAssets } from "./support/assets";
import { expect, expectNoCspViolations, test, watchCsp, type CspWatch } from "./support/csp";
import { openReadingPanel } from "./support/reading-panel";
import { SEEDED } from "./support/seed-data";
import { SKIP_DB, SKIP_DB_REASON, stackUrl } from "./support/stack";

/**
 * Task 12.1: security headers and the Content-Security-Policy, against the production build.
 *
 * 1. Headers: Playwright's API client reads the raw responses of pages, route handlers, the image
 *    proxy, a build file, a not-found page and a malformed URL on the database-free `fixtures`
 *    server, and compares them with the builders in `src/lib/security-headers.ts`.
 * 2. No violations: a visitor walks every kind of page on the seeded database, in light and dark,
 *    using the features that need the CSP's allowances (Shiki code with the copy button, a Mermaid
 *    diagram and its enlarge dialog, an image, the command palette with live results, the theme
 *    toggle, OKF pages, not-found pages), and the browser reports zero CSP violations and zero
 *    console errors. (Every other spec also fails on a CSP violation: see `e2e/support/csp.ts`.)
 * 3. Negative controls: the policy really blocks an injected inline script, an inline event
 *    handler, `eval` and a plain-http image, and allows an https image.
 */

const NONCE_IN_CSP = /'nonce-([A-Za-z0-9+/]{22}==)'/;

function nonceOf(response: APIResponse): string {
  const csp = response.headers()["content-security-policy"] ?? "";
  const nonce = NONCE_IN_CSP.exec(csp)?.[1];
  expect(nonce, `no nonce in ${csp}`).toBeDefined();
  return nonce as string;
}

/** Asserts the page CSP (for this response's nonce) and every baseline header. */
function expectPageHeaders(response: APIResponse, { https = false } = {}): void {
  const headers = response.headers();
  const nonce = nonceOf(response);
  expect(headers["content-security-policy"]).toBe(buildContentSecurityPolicy({ nonce, https }));
  expectBaselineHeaders(response);
  if (https) expect(headers["strict-transport-security"]).toBe(HSTS_VALUE);
  else expect(headers["strict-transport-security"]).toBeUndefined();
}

function expectBaselineHeaders(response: APIResponse, except: readonly string[] = []): void {
  const headers = response.headers();
  for (const [key, value] of BASELINE_HEADERS) {
    if (except.includes(key.toLowerCase())) continue;
    expect(headers[key.toLowerCase()], key).toBe(value);
  }
  expect(headers["x-powered-by"]).toBeUndefined();
}

test.describe("security headers on the built app", () => {
  test.use({ baseURL: stackUrl("fixtures") });

  for (const path of ["/", "/search", "/search?q=deployment", "/e2e/theme"]) {
    test(`page ${path} has the CSP and every security header`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBeLessThan(500);
      expect(response.headers()["content-type"]).toContain("text/html");
      expectPageHeaders(response);
    });
  }

  test("every script in the HTML carries this response's nonce, and nonces never repeat", async ({
    request,
  }) => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const response = await request.get("/e2e/theme");
      const nonce = nonceOf(response);
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
      const html = await response.text();
      const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
      expect(scripts.length).toBeGreaterThan(1);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
      // the theme script is inline (no src) and still the first thing in <body>
      const body = html.slice(html.indexOf("<body"));
      const first = /<script\b[^>]*>/i.exec(body)?.[0] ?? "";
      expect(first).not.toMatch(/\bsrc=/);
      expect(body.indexOf("<script")).toBeLessThan(body.indexOf("<header"));
    }
  });

  test("behind a TLS-terminating proxy: HSTS and upgrade-insecure-requests", async ({
    request,
  }) => {
    const response = await request.get("/", { headers: { "x-forwarded-proto": "https" } });
    expectPageHeaders(response, { https: true });
    expect(response.headers()["content-security-policy"]).toMatch(/; upgrade-insecure-requests$/);
  });

  test("route handlers get the same headers: /api/search", async ({ request }) => {
    const response = await request.get("/api/search?q=deployment");
    expect(response.headers()["content-type"]).toContain("application/json");
    expectPageHeaders(response);
  });

  test("the image proxy keeps its own sandbox CSP, Referrer-Policy, nosniff and CORP", async ({
    request,
  }) => {
    // refused before any database or GitHub access: not an image extension
    const response = await request.get("/api/asset/acme/doc-showcase/docs/notes.txt");
    expect(response.status()).toBe(415);
    const headers = response.headers();
    expect(headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expectBaselineHeaders(response, ["referrer-policy"]);
  });

  test("build files under /_next/static get the baseline headers, without a CSP", async ({
    request,
  }) => {
    const html = await (await request.get("/e2e/theme")).text();
    const chunk = /\/_next\/static\/[^"]+\.js/.exec(html)?.[0];
    expect(chunk).toBeDefined();
    const response = await request.get(chunk as string);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("immutable");
    expectBaselineHeaders(response);
    expect(response.headers()["content-security-policy"]).toBeUndefined();
    const missing = await request.get("/_next/static/chunks/does-not-exist.js");
    expect(missing.status()).toBe(404);
    expectBaselineHeaders(missing);
  });

  test("a not-found page has the headers", async ({ request }) => {
    const response = await request.get("/no/such/page/anywhere/here");
    expect(response.status()).toBe(404);
    expectPageHeaders(response);
  });

  for (const path of [
    "/acme/%E0%A4%A",
    "/api/%E0%A4%A",
    "/acme/repo/docs/%ZZ",
    "/acme/%C3%28",
    "/%",
    "/api/asset/acme/repo/%E0%A4%A.png",
    "/search/%FF",
  ]) {
    test(`a malformed percent escape is a 400 with headers, not a 500: ${path}`, async ({
      request,
    }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(400);
      expect(await response.text()).toContain("malformed percent escape");
      expectPageHeaders(response);
    });
  }

  test("well-formed escapes still reach the app", async ({ request }) => {
    const response = await request.get("/e2e/theme?x=%E2%9C%93");
    expect(response.status()).toBe(200);
    // a valid escape in a dynamic segment goes on to the page (no database here: not found)
    const encoded = await request.get("/acme/caf%C3%A9%20%25");
    expect(encoded.status()).toBe(404);
    expectPageHeaders(encoded);
  });
});

async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // hydrated: the toggle replaces its placeholder on mount
  await expect(page.getByRole("button", { name: "Text size and reading options" })).toBeVisible();
}

/** Console errors, minus the browser's own line for a page we expect to answer 404. */
function unexpectedErrors(watch: CspWatch, allow404 = false): string[] {
  return watch.errors.filter(
    (e) =>
      !(allow404 && /Failed to load resource: the server responded with a status of 404/.test(e)),
  );
}

test.describe("no CSP violations or console errors anywhere, seeded database", () => {
  test.skip(SKIP_DB, SKIP_DB_REASON);
  test.use({ baseURL: stackUrl("seeded") });

  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} theme`, () => {
      test.use({ colorScheme: theme });

      test("home, repository pages, search and OKF pages", async ({ page, context }) => {
        const watch = await watchCsp(context);
        await stubAssets(page);
        for (const path of [
          "/",
          `/${SEEDED.full.owner}/${SEEDED.full.name}`,
          `/${SEEDED.richReadme.owner}/${SEEDED.richReadme.name}`,
          `/${SEEDED.okf.owner}/${SEEDED.okf.name}`,
          `/${SEEDED.okfShowcase.owner}/${SEEDED.okfShowcase.name}?type=concept`,
          `/${SEEDED.okfShowcase.owner}/${SEEDED.okfShowcase.name}/docs/concepts/full-metadata`,
          `/${SEEDED.okfShowcase.owner}/${SEEDED.okfShowcase.name}/docs/concepts/deprecated-metric`,
          `/${SEEDED.okfShowcase.owner}/${SEEDED.okfShowcase.name}/docs/log`,
          `/${SEEDED.privateOkf.owner}/${SEEDED.privateOkf.name}`,
          "/search?q=deployment",
          "/search?q=deployment&type=concept",
        ]) {
          await visit(page, path);
        }
        // the README diagram of rich-readme rendered client-side
        await visit(page, `/${SEEDED.richReadme.owner}/${SEEDED.richReadme.name}`);
        await expect(page.locator(".dmr-mermaid-diagram svg").first()).toBeVisible({
          timeout: 30_000,
        });
        expectNoCspViolations(watch);
        expect(unexpectedErrors(watch)).toEqual([]);
      });

      test("document page: code, copy button, image, diagram, enlarge dialog, theme switch", async ({
        page,
        context,
      }) => {
        const watch = await watchCsp(context);
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const requested = await stubAssets(page);
        await visit(
          page,
          `/${SEEDED.showcase.owner}/${SEEDED.showcase.name}/docs/guides/getting-started`,
        );
        const body = page.getByTestId("doc-body");
        await expect(body.locator("pre.shiki").first()).toBeVisible();
        // Shiki colours come from style attributes: they must apply (style-src 'unsafe-inline')
        const token = await body
          .locator("pre.shiki span[style]")
          .first()
          .evaluate((el) => ({
            declared: /--shiki-light:\s*([^;]+)/.exec(el.getAttribute("style") ?? "")?.[1]?.trim(),
            applied: getComputedStyle(el).getPropertyValue("--shiki-light").trim(),
          }));
        expect(token.declared).toBeTruthy();
        expect(token.applied).toBe(token.declared);
        await body.getByRole("button", { name: "Copy code" }).first().click();
        await expect(body.getByText("Copied", { exact: true }).first()).toBeVisible();
        const image = body.getByRole("img", { name: "Architecture overview" });
        await expect
          .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
          .toBeGreaterThan(0);
        expect(requested.length).toBeGreaterThan(0);
        const diagram = body.locator(".dmr-mermaid-diagram svg").first();
        await expect(diagram).toBeVisible({ timeout: 30_000 });
        // Mermaid's own <style> inside the SVG applies (style-src 'unsafe-inline')
        expect(await diagram.locator("style").count()).toBeGreaterThan(0);
        await page.getByRole("button", { name: "Enlarge diagram" }).first().click();
        const dialog = page.getByRole("dialog", { name: "Diagram" });
        await expect(dialog.locator("svg").first()).toBeVisible();
        await dialog.getByRole("button", { name: "Zoom in" }).click();
        await dialog.getByRole("button", { name: "Close" }).click();
        await expect(dialog).toBeHidden();
        // switch theme in place: Mermaid re-renders, Shiki swaps variables
        const other = theme === "light" ? "Dark" : "Light";
        await openReadingPanel(page);
        await page.getByRole("radio", { name: other }).click();
        await expect(page.locator("html")).toHaveClass(
          theme === "light" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
        );
        await expect(diagram).toBeVisible();
        await page.getByRole("radio", { name: "System" }).click();
        expectNoCspViolations(watch);
        expect(unexpectedErrors(watch)).toEqual([]);
      });

      test("command palette with live results", async ({ page, context }) => {
        const watch = await watchCsp(context);
        await visit(page, "/");
        await page.keyboard.press("Control+k");
        const dialog = page.getByRole("dialog", { name: "Quick search" });
        await expect(dialog).toBeVisible();
        await page.getByRole("combobox").pressSequentially("deployment");
        await page.getByRole("option").first().click();
        await expect(page).toHaveURL(/\/docs\//);
        await expect(page.getByTestId("doc-body")).toBeVisible();
        expectNoCspViolations(watch);
        expect(unexpectedErrors(watch)).toEqual([]);
      });

      test("not-found pages", async ({ page, context }) => {
        const watch = await watchCsp(context);
        for (const path of [
          "/acme/no-such-repository",
          `/${SEEDED.full.owner}/${SEEDED.full.name}/docs/no/such/doc`,
          "/no/such/page/anywhere/here",
        ]) {
          const response = await page.goto(path);
          expect(response?.status()).toBe(404);
          await expect(
            page.getByRole("button", { name: "Text size and reading options" }),
          ).toBeVisible();
        }
        expectNoCspViolations(watch);
        expect(unexpectedErrors(watch, true)).toEqual([]);
      });
    });
  }
});

test.describe("the policy blocks what it should (negative controls)", () => {
  test.use({ baseURL: stackUrl("fixtures") });

  test("the real page's own scripts all run: no violation on a clean visit", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: stackUrl("fixtures") });
    try {
      const watch = await watchCsp(context);
      const page = await context.newPage();
      await visit(page, "/e2e/theme");
      await openReadingPanel(page);
      await page.getByRole("radio", { name: "Dark" }).click();
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      expectNoCspViolations(watch);
      expect(watch.errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("markup injected into the served HTML cannot run script; eval is refused", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: stackUrl("fixtures") });
    try {
      const watch = await watchCsp(context);
      const page = await context.newPage();
      // Simulates an HTML injection (a sanitizer bypass): the real response, real headers, with
      // an inline script, an inline event handler and a javascript: URL added to the body.
      await page.route("**/e2e/theme", async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(
          "</body>",
          [
            "<script>window.__dmrInjected = true</script>",
            '<img src="/no-such-image.png" onerror="window.__dmrHandler = true" alt="">',
            '<a id="dmr-js-link" href="javascript:window.__dmrLink = true">x</a>',
            "</body>",
          ].join(""),
        );
        await route.fulfill({ response, body: html });
      });
      await visit(page, "/e2e/theme");
      await page.locator("#dmr-js-link").click();

      const outcome = await page.evaluate(async () => {
        const w = window as unknown as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 300));
        let evalResult: string;
        try {
          evalResult = String((0, eval)("'evaluated'"));
        } catch (error) {
          evalResult = (error as Error).name;
        }
        let functionResult: string;
        try {
          functionResult = String(new Function("return 'constructed'")());
        } catch (error) {
          functionResult = (error as Error).name;
        }
        return {
          injected: w.__dmrInjected ?? null,
          handler: w.__dmrHandler ?? null,
          link: w.__dmrLink ?? null,
          evalResult,
          functionResult,
        };
      });
      expect(outcome).toEqual({
        injected: null,
        handler: null,
        link: null,
        evalResult: "EvalError",
        functionResult: "EvalError",
      });
      await expect
        .poll(() => watch.violations.map((v) => v.directive))
        .toEqual(expect.arrayContaining(["script-src-attr", "script-src-elem"]));
      // the blocked inline script and handler were reported with their source
      expect(
        watch.violations.filter((v) => v.blockedURI === "inline").length,
      ).toBeGreaterThanOrEqual(3);
      await expect
        .poll(() =>
          watch.violations.some((v) => v.directive === "script-src" && v.blockedURI === "eval"),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  test("a plain-http image is blocked; an https image is allowed", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: stackUrl("fixtures") });
    try {
      const watch = await watchCsp(context);
      const page = await context.newPage();
      // Never touch the network: both hosts answer with a PNG, so only the CSP can refuse one.
      await page.route(/^https?:\/\/example\.invalid\//, (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
      );
      await visit(page, "/e2e/theme");
      const load = (src: string) =>
        page.evaluate(
          (url) =>
            new Promise<string>((resolve) => {
              const img = new Image();
              img.onload = () => resolve("loaded");
              img.onerror = () => resolve("blocked");
              img.src = url;
            }),
          src,
        );
      expect(await load("https://example.invalid/badge.png")).toBe("loaded");
      expect(watch.violations).toEqual([]);
      expect(await load("http://example.invalid/badge.png")).toBe("blocked");
      await expect
        .poll(() => watch.violations.map((v) => [v.directive, v.blockedURI]))
        .toEqual([["img-src", "http://example.invalid/badge.png"]]);
    } finally {
      await context.close();
    }
  });
});
