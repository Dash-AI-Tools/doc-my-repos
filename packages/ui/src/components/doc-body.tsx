import { CodeCopyEnhancer } from "./code-copy";
import { MermaidEnhancer } from "./mermaid-enhancer";

/**
 * The body of a document page (task 9.7). Presentational; the view is prepared on the server
 * (`packages/server/src/doc-page.ts`):
 * - `rendered`: the sanitized HTML of `renderMarkdown`, injected as is (sanitizing is the
 *   pipeline's job and happens after every transform, never here), in the same wrappers as the
 *   README: `.markdown-body` for the styles, `CodeCopyEnhancer` for the copy buttons and
 *   `MermaidEnhancer` for the diagrams. When the body opens with an `h1` that repeats the page
 *   title (`hideTitleHeading`), `data-hide-title` lets CSS hide that one heading, so the page has
 *   one visible and one accessible `h1`.
 * - `plain`: rendering failed; the Markdown is shown as text (React escapes it).
 */
export type DocBodyData =
  | { readonly status: "rendered"; readonly html: string; readonly hideTitleHeading: boolean }
  | { readonly status: "plain"; readonly text: string };

export function DocBody({ body }: { readonly body: DocBodyData }) {
  if (body.status === "plain") {
    return (
      <pre
        data-testid="doc-plain"
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border bg-code-background p-3 font-mono text-sm whitespace-pre-wrap text-code-foreground [overflow-wrap:anywhere]"
      >
        {body.text}
      </pre>
    );
  }
  return (
    <MermaidEnhancer>
      <CodeCopyEnhancer>
        <div
          className="markdown-body"
          data-testid="doc-body"
          data-hide-title={body.hideTitleHeading ? "" : undefined}
          dangerouslySetInnerHTML={{ __html: body.html }}
        />
      </CodeCopyEnhancer>
    </MermaidEnhancer>
  );
}
