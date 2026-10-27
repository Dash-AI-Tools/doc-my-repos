import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { CodeCopyEnhancer } from "../components/code-copy";
import { MermaidEnhancer } from "../components/mermaid-enhancer";
import { e2eFixturesEnabled } from "@docmyrepos/core/internal/e2e-fixtures";
import { TOKEN_NAMES } from "@docmyrepos/core/internal/theme-tokens";
import { rehypeHighlight } from "@docmyrepos/server/internal/markdown/highlight";
import { renderMarkdown } from "@docmyrepos/server/internal/markdown/pipeline";

/**
 * DESIGN TOKEN SHOWCASE (task 8.1), a dev and test page, not a product page.
 *
 * Renders a swatch for every token plus sample text, links, badges, buttons, inputs, cards and a
 * Markdown document (through the real pipeline, with highlighted code and a Mermaid diagram) so
 * both palettes can be inspected by eye and by `e2e/theme-tokens.spec.ts`. Same guard as the other
 * fixture pages: 404 unless `E2E_FIXTURES=1` (see `packages/core/src/e2e-fixtures.ts`), checked per request.
 * Run it locally with `E2E_FIXTURES=1 pnpm dev` and open `/e2e/theme`.
 * The root layout's `ThemeProvider` (task 8.2) applies the theme.
 */

const SAMPLE = [
  "# Markdown sample",
  "",
  "Body text with a [working link](/e2e/theme), a [broken link](./missing.md), `inline code`,",
  "**bold**, _italic_, ~~struck~~ and <kbd>Ctrl</kbd> + <kbd>K</kbd>.",
  "",
  "## Lists and tasks",
  "",
  "- first item",
  "  - nested item",
  "- second item",
  "",
  "1. one",
  "2. two",
  "",
  "- [x] done task",
  "- [ ] open task",
  "",
  "> A blockquote with muted text.",
  "",
  "### Table",
  "",
  "| Name | Type | Status |",
  "| ---- | ---- | ------ |",
  "| alpha | guide | draft |",
  "| beta | runbook | stable |",
  "",
  "<details><summary>Details</summary>Hidden content.</details>",
  "",
  "```ts",
  "// Highlighted code",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B{Choice}",
  "  B -->|yes| C[Done]",
  "  B -->|no| D[Retry]",
  "```",
  "",
  "A footnote reference.[^1]",
  "",
  "[^1]: The footnote text.",
  "",
].join("\n");

const BADGE = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium";
const BUTTON = "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium";

export async function E2eThemePage() {
  await connection();
  if (!e2eFixturesEnabled(process.env)) notFound();
  const { html } = await renderMarkdown(SAMPLE, { slots: { highlight: [rehypeHighlight] } });
  return (
    <div className="space-y-10" data-testid="theme-showcase">
      <section aria-labelledby="sw">
        <h1 id="sw" className="text-2xl font-bold">
          Design tokens
        </h1>
        <p className="mt-1 text-muted-foreground">
          Every token as a swatch, with its name. Light and dark palettes.
        </p>
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {TOKEN_NAMES.map((name) => (
            <li key={name} className="rounded-md border border-border bg-card p-2 text-xs">
              <div
                aria-hidden="true"
                data-swatch={name}
                className="h-8 rounded border border-border"
                style={{ backgroundColor: `var(--${name})` }}
              />
              <code className="mt-1 block text-card-foreground">{name}</code>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ui" className="space-y-4">
        <h2 id="ui" className="text-xl font-semibold">
          Components
        </h2>
        <p>
          Body text,{" "}
          <Link href="/e2e/theme" prefetch={false}>
            a link
          </Link>
          , and <span className="text-muted-foreground">muted text</span>.
        </p>

        <div className="flex flex-wrap gap-2" data-testid="badges">
          <span className={`${BADGE} bg-private-badge text-private-badge-foreground`}>private</span>
          <span className={`${BADGE} bg-okf-badge text-okf-badge-foreground`}>OKF</span>
          <span className={`${BADGE} bg-success text-success-foreground`}>synced</span>
          <span className={`${BADGE} bg-warning text-warning-foreground`}>syncing</span>
          <span className={`${BADGE} bg-destructive text-destructive-foreground`}>error</span>
          <span className={`${BADGE} bg-accent text-accent-foreground`}>guide</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${BUTTON} bg-primary text-primary-foreground hover:opacity-90`}
          >
            Primary
          </button>
          <button
            type="button"
            className={`${BUTTON} bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground`}
          >
            Secondary
          </button>
          <button
            type="button"
            className={`${BUTTON} bg-destructive text-destructive-foreground hover:opacity-90`}
          >
            Destructive
          </button>
          <button
            type="button"
            className={`${BUTTON} border border-input bg-background text-foreground hover:bg-muted`}
          >
            Outline
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="theme-q" className="text-sm font-medium">
            Search
          </label>
          <input
            id="theme-q"
            type="search"
            placeholder="Search documentation"
            className="w-64 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
          />
          <select
            aria-label="Sort"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option>Relevance</option>
            <option>Updated</option>
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
            <h3 className="font-semibold">Card</h3>
            <p className="mt-1 text-sm text-muted-foreground">Card with muted secondary text.</p>
            <p className="mt-2 text-sm">
              <Link href="/e2e/theme" prefetch={false}>
                Card link
              </Link>
            </p>
          </div>
          <div className="rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md">
            <h3 className="font-semibold">Popover</h3>
            <p className="mt-1 text-sm text-muted-foreground">Menu or dialog surface.</p>
          </div>
        </div>

        <div className="rounded border border-destructive-muted-border bg-destructive-muted p-3 text-destructive-muted-foreground">
          <p role="alert" className="text-sm font-medium">
            Error box (Mermaid failure, sync error).
          </p>
        </div>
      </section>

      <section aria-labelledby="md">
        <h2 id="md" className="sr-only">
          Markdown
        </h2>
        <MermaidEnhancer>
          <CodeCopyEnhancer>
            <div
              data-testid="fixture-doc"
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </CodeCopyEnhancer>
        </MermaidEnhancer>
      </section>
    </div>
  );
}
