import {
  THEME_TOKENS,
  type TokenName,
  type TokenSet,
} from "@docmyrepos/core/internal/theme-tokens";

/**
 * Last-resort error boundary (hardening after the epic 8 and 9 review). `error.tsx` sits below
 * the root layout, so a crash in the layout itself (header, theme provider, command palette,
 * reading the request headers) would otherwise fall back to Next.js's default error page. This
 * file replaces the root layout in that case, so it renders its own `<html>` and `<body>` and has
 * nothing from the app to lean on: no `globals.css`, no Tailwind, no `ThemeProvider`, no shared
 * components.
 *
 * - Colors: the same design tokens as the rest of the app (`packages/core/src/theme-tokens.ts`, so the
 *   contrast tests cover the values), written into one inline `<style>` as custom properties. There
 *   is no `dark` class here (the provider that sets it is gone), so the dark values apply through
 *   `prefers-color-scheme`; the visitor's in-app choice is not known without script. Inline style
 *   is allowed by the CSP (`style-src 'unsafe-inline'`); there is no script and no external
 *   request.
 * - Content: fixed text and the error `digest` (Next.js's hash, which matches the server log
 *   line). The error message and stack are never shown: in production they are already redacted,
 *   and in development they could carry connection details.
 * - Actions: a retry button (`reset`, then a full reload) and a plain link home (a full page load, which also works
 *   when client navigation is what broke).
 */
export const GLOBAL_ERROR_TOKENS = [
  "background",
  "foreground",
  "muted-foreground",
  "border",
  "ring",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "destructive-muted",
  "destructive-muted-foreground",
  "destructive-muted-border",
] as const satisfies readonly TokenName[];

function declarations(tokens: TokenSet): string {
  return GLOBAL_ERROR_TOKENS.map((name) => `--${name}:${tokens[name]};`).join("");
}

/** The stylesheet of the page. Pure, so a test can read the values the browser would get. */
export function globalErrorCss(): string {
  return [
    `:root{color-scheme:light dark;${declarations(THEME_TOKENS.light)}}`,
    `@media (prefers-color-scheme:dark){:root{${declarations(THEME_TOKENS.dark)}}}`,
    "*,*::before,*::after{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;" +
      "background:var(--background);color:var(--foreground);" +
      'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;' +
      "line-height:1.5}",
    "main{width:100%;max-width:36rem}",
    ".panel{border:1px solid var(--destructive-muted-border);border-radius:.5rem;padding:1.5rem;" +
      "background:var(--destructive-muted);color:var(--destructive-muted-foreground)}",
    "h1{margin:0;font-size:1.5rem;line-height:1.3;font-weight:700}",
    "p{margin:.75rem 0 0}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}",
    ".actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}",
    ".action{display:inline-flex;align-items:center;justify-content:center;height:2.5rem;padding:0 1rem;" +
      "border:1px solid transparent;border-radius:.375rem;font:inherit;font-size:.875rem;font-weight:500;" +
      "text-decoration:none;cursor:pointer}",
    ".primary{background:var(--primary);color:var(--primary-foreground)}",
    ".secondary{background:var(--secondary);color:var(--secondary-foreground);border-color:var(--border)}",
    ".action:hover{opacity:.9}",
    ":focus-visible{outline:2px solid var(--ring);outline-offset:2px}",
  ].join("\n");
}

/** What the page says, apart from the document shell. Exported for tests. */
export function GlobalErrorContent({
  error,
  reset,
  reload = () => window.location.reload(),
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Fetches the page again. Default: a full reload. Replaceable in tests. */
  reload?: () => void;
}) {
  // Only a short, plain reference is shown, whatever the digest holds.
  const digest =
    typeof error.digest === "string" && error.digest !== "" ? error.digest.slice(0, 64) : null;
  return (
    <main>
      <section
        role="alert"
        aria-labelledby="global-error-heading"
        data-testid="global-error"
        className="panel"
      >
        <h1 id="global-error-heading">Something went wrong</h1>
        <p>DocMyRepos could not show this page. Nothing has been lost; please try again.</p>
        {digest !== null ? (
          <p>
            Reference: <code data-testid="global-error-digest">{digest}</code>
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              // `reset` alone re-renders the error that came from the server; the reload fetches
              // the page again, which is the only retry that can help when the layout failed.
              reset();
              reload();
            }}
            className="action primary"
          >
            Try again
          </button>
          {/* A plain anchor on purpose: a full page load, independent of the router that may
              have failed (and next/link needs the router context this page may not have). */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="action secondary">
            Back to the home page
          </a>
        </div>
      </section>
    </main>
  );
}
