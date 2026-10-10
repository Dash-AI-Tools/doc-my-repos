import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ThemeProvider } from "next-themes";

import { CodeCopyEnhancer } from "@/components/code-copy";
import { MermaidEnhancer } from "@/components/mermaid-enhancer";
import { e2eFixturesEnabled } from "@/lib/e2e-fixtures";
import { rehypeHighlight } from "@/server/markdown/highlight";
import { renderMarkdown } from "@/server/markdown/pipeline";

/**
 * E2E FIXTURE, not a product page (task 7.8).
 *
 * There is no documentation page yet, so Playwright (e2e/*.spec.ts) needs something that mounts
 * the real client components (`MermaidEnhancer`, `CodeCopyEnhancer`) on HTML produced by the real
 * pipeline (`renderMarkdown`). Group 10 may replace this with the real doc page and point the
 * specs at it; then delete this file and `src/lib/e2e-fixtures.ts`.
 *
 * It is a 404 unless `E2E_FIXTURES=1` is set in the server environment, which only the
 * Playwright `webServer` does. It is not linked from the nav and not in any sitemap. The check
 * runs per request (`connection()`), so a production build never bakes it in.
 *
 * It mounts its own next-themes `ThemeProvider` (`attribute="class"`, system default, as group 8
 * will) so the specs switch light and dark with `colorScheme` and the Mermaid theme follows.
 *
 * Group 10 note: this route is `/e2e/mermaid`, so a repo named `mermaid` in an org named `e2e`
 * would be shadowed by it in `/[owner]/[repo]`; the guard keeps it from existing in production.
 */

const BASIC = [
  "# Mermaid fixture",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B{Choice}",
  "  B -->|yes| C[Done]",
  "  B -->|no| D[Retry]",
  "```",
  "",
  "```ts",
  "export const answer: number = 42;",
  "```",
  "",
].join("\n");

/** Strict mode must not let a label load an external image unnoticed: the spec records what happens. */
const EXTERNAL_IMAGE = [
  "# External image fixture",
  "",
  "```mermaid",
  "graph TD",
  `  A["<img src='https://example.invalid/x.png'>"]`,
  "```",
  "",
].join("\n");

/** Fixed documents only: the query picks one by name, it never supplies Markdown. */
const DOCS: Readonly<Record<string, string>> = { basic: BASIC, "external-image": EXTERNAL_IMAGE };

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  if (!e2eFixturesEnabled(process.env)) notFound();
  const { doc } = await searchParams;
  const source = (typeof doc === "string" ? DOCS[doc] : undefined) ?? BASIC;
  const { html } = await renderMarkdown(source, { slots: { highlight: [rehypeHighlight] } });
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MermaidEnhancer>
        <CodeCopyEnhancer>
          <div data-testid="fixture-doc" dangerouslySetInnerHTML={{ __html: html }} />
        </CodeCopyEnhancer>
      </MermaidEnhancer>
    </ThemeProvider>
  );
}
