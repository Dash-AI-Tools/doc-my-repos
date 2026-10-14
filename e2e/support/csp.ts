import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Content-Security-Policy violation capture for e2e specs (task 12.1).
 *
 * `watchCsp(target)` records, for a page or a whole browser context and across navigations:
 * - every `securitypolicyviolation` event (an init script listens on each document before any
 *   page script runs and reports through a Playwright binding, which the page's CSP cannot block),
 * - every console message in which the browser says it refused something because of the CSP, or
 *   complains about the CSP or Permissions-Policy header itself (warnings included),
 * - every console error and uncaught page error (`errors`), for specs that also want a clean
 *   console.
 *
 * `test` below is `@playwright/test`'s `test` with the default `context` fixture wrapped: every
 * spec that imports it fails when any page of its context reports a CSP violation, whatever the
 * test itself checks. Contexts a test creates itself (`browser.newContext()`) are not watched;
 * call `watchCsp` on them when it matters.
 */

export interface CspViolation {
  readonly directive: string;
  readonly blockedURI: string;
  readonly sourceFile: string;
  readonly sample: string;
  readonly documentURI: string;
}

export interface CspWatch {
  /** `securitypolicyviolation` events. */
  readonly violations: CspViolation[];
  /** Console messages about the CSP ("Refused to ...") or the Permissions-Policy header. */
  readonly consoleViolations: string[];
  /** Console errors and uncaught page errors (CSP messages included). */
  readonly errors: string[];
}

const BINDING = "__dmrReportCspViolation";

const CSP_MESSAGE =
  /Content Security Policy|Content-Security-Policy|Permissions-Policy|Refused to (?:load|execute|apply|evaluate|connect|frame)/i;

const watched = new WeakMap<Page | BrowserContext, CspWatch>();

export async function watchCsp(target: Page | BrowserContext): Promise<CspWatch> {
  const existing = watched.get(target);
  if (existing) return existing;
  const watch: CspWatch = { violations: [], consoleViolations: [], errors: [] };
  watched.set(target, watch);

  await target.exposeBinding(BINDING, (_source, violation: CspViolation) => {
    watch.violations.push(violation);
  });
  await target.addInitScript((binding) => {
    document.addEventListener(
      "securitypolicyviolation",
      (event) => {
        const report = (window as unknown as Record<string, (v: unknown) => void>)[binding];
        report?.({
          directive: event.effectiveDirective || event.violatedDirective,
          blockedURI: event.blockedURI,
          sourceFile: event.sourceFile,
          sample: event.sample,
          documentURI: event.documentURI,
        });
      },
      true,
    );
  }, BINDING);

  const onConsole = (message: { type(): string; text(): string }) => {
    const text = message.text();
    if (CSP_MESSAGE.test(text)) watch.consoleViolations.push(text);
    if (message.type() === "error") watch.errors.push(`console: ${text}`);
  };
  const onPageError = (error: Error) => watch.errors.push(`pageerror: ${error.message}`);
  if ("newPage" in target) {
    target.on("console", onConsole);
    target.on("weberror", (webError) => onPageError(webError.error()));
  } else {
    target.on("console", onConsole);
    target.on("pageerror", onPageError);
  }
  return watch;
}

/** Fails with a readable list when the watch saw any CSP violation. */
export function expectNoCspViolations(watch: CspWatch): void {
  expect(
    { violations: watch.violations, consoleViolations: watch.consoleViolations },
    "Content-Security-Policy violations",
  ).toEqual({ violations: [], consoleViolations: [] });
}

/** `test` whose default context is watched; any CSP violation fails the test. */
export const test = base.extend({
  context: async ({ context }, provide) => {
    const watch = await watchCsp(context);
    await provide(context);
    expectNoCspViolations(watch);
  },
});

export { expect };
