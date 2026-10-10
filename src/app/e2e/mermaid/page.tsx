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

function mermaidDoc(title: string, lines: readonly string[]): string {
  return [`# ${title}`, "", "```mermaid", ...lines, "```", ""].join("\n");
}

/**
 * Mermaid diagrams that try to make the viewer's browser request https://example.invalid/. The
 * spec asserts that no request is made (strict mode alone does not stop these; see
 * src/components/mermaid-svg.ts).
 */
const EXTERNAL_IMAGE = mermaidDoc("External image fixture", [
  "graph TD",
  `  A["<img src='https://example.invalid/x.png'>"]`,
]);

const IMAGE_SHAPE = mermaidDoc("Image shape fixture", [
  "flowchart LR",
  `  A@{ img: "https://example.invalid/shape.png", label: "Shape", pos: "b", w: 60, h: 60 }`,
  "  A --> B",
]);

const STYLE_URL = mermaidDoc("Style url fixture", [
  "graph TD",
  "  A[Styled] --> B[Plain]",
  "  style A fill:url(https://example.invalid/fill.png),stroke:black",
  "  classDef bg background:url(https://example.invalid/bg.png),fill:url(//example.invalid/c.png)",
  "  class B bg",
]);

const THEME_CSS = mermaidDoc("Theme CSS fixture", [
  `%%{init: {"themeCSS": "@import url(https://example.invalid/t.css); .node rect{fill:url(https://example.invalid/t.png)}"}}%%`,
  "graph TD",
  "  A[Themed] --> B[Plain]",
]);

const LABEL_VARIANTS = mermaidDoc("Label variants fixture", [
  "graph TD",
  `  A["<svg><image href='https://example.invalid/i.png'/></svg>"] --> B["<iframe src='https://example.invalid/f'></iframe>"]`,
  `  B --> C["<video poster='https://example.invalid/p.png' src='https://example.invalid/v.mp4'></video>"]`,
  `  C --> D["<div style='background:url(https://example.invalid/d.png)'>styled</div>"]`,
  `  D --> E["<link rel=stylesheet href='https://example.invalid/s.css'>"]`,
]);

const SEQUENCE_IMAGE = mermaidDoc("Sequence fixture", [
  "sequenceDiagram",
  `  participant A as <img src='https://example.invalid/seq.png'>Alice`,
  "  A->>B: Hello",
]);

/** Fixed documents only: the query picks one by name, it never supplies Markdown. */
const DOCS: Readonly<Record<string, string>> = {
  basic: BASIC,
  "external-image": EXTERNAL_IMAGE,
  "image-shape": IMAGE_SHAPE,
  "style-url": STYLE_URL,
  "theme-css": THEME_CSS,
  "label-variants": LABEL_VARIANTS,
  "sequence-image": SEQUENCE_IMAGE,
};

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
