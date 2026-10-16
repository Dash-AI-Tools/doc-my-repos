import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expectNoCspViolations, watchCsp } from "./csp";
import { COMMENT_USERS, type CommentUser } from "./comment-data";
import { stackUrl, type StackName } from "./stack";

/**
 * Helpers of the comments e2e specs. A "session" is a browser context whose requests carry
 * `x-e2e-user` (see `getCurrentUser`), so each seeded user can be played in the same test.
 */

export interface Session {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Closes the context; fails when the page broke the Content-Security-Policy. */
  readonly close: () => Promise<void>;
}

export interface SessionOptions {
  readonly stack?: StackName;
  /** The seeded user to act as; none is the fixed admin without a row. */
  readonly user?: CommentUser;
  readonly theme?: "light" | "dark";
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Cookie `docmyrepos-text-size`. */
  readonly textSize?: "small" | "default" | "large" | "larger" | "largest";
}

export async function openSession(
  browser: Browser,
  options: SessionOptions = {},
): Promise<Session> {
  const stack = options.stack ?? "comments";
  const context = await browser.newContext({
    baseURL: stackUrl(stack),
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.user
      ? { extraHTTPHeaders: { "x-e2e-user": COMMENT_USERS[options.user].email } }
      : {}),
  });
  const watch = await watchCsp(context);
  if (options.theme) {
    await context.addInitScript(
      (value) => localStorage.setItem("docmyrepos-theme", value),
      options.theme,
    );
  }
  if (options.textSize) {
    await context.addCookies([
      { name: "docmyrepos-text-size", value: options.textSize, url: stackUrl(stack) },
    ]);
  }
  const page = await context.newPage();
  return {
    context,
    page,
    close: async () => {
      await context.close();
      expectNoCspViolations(watch);
    },
  };
}

/** The reader path of a seeded document: `docs/guides/setup.md` of acme/api-service. */
export function docUrl(doc: { owner: string; name: string; path: string }): string {
  return `/${doc.owner}/${doc.name}/${doc.path.replace(/\.md$/, "")}`;
}
