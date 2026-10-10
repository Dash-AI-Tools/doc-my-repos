import { CodeCopyEnhancer } from "./code-copy";
import { MermaidEnhancer } from "./mermaid-enhancer";

/**
 * The README section of the repository page (task 9.4, spec "Repository space page"). Presentational.
 *
 * `readme` is prepared on the server (`src/server/repo-page.ts`):
 * - `rendered`: the sanitized HTML of `renderMarkdown`. It is injected as is; sanitizing is the
 *   pipeline's job and happens after every transform, never here. It sits in the same wrappers as
 *   every rendered document: `.markdown-body` for the styles, `CodeCopyEnhancer` for the copy
 *   buttons and `MermaidEnhancer` for the diagrams (client-side, strict).
 * - `plain`: rendering failed, so the Markdown is shown as plain text in a `<pre>`; React escapes
 *   it. `notice` says why.
 * - `missing`: the repository has no README. The section says so and how to add one; the rest of
 *   the page is unaffected (spec "Missing README").
 */

export type ReadmeViewData =
  | { readonly status: "rendered"; readonly html: string; readonly notice?: string }
  | { readonly status: "plain"; readonly text: string; readonly notice: string }
  | { readonly status: "missing" };

export interface ReadmeSectionProps {
  readonly readme: ReadmeViewData;
  /** Repo-relative path of the README, shown next to the heading. */
  readonly path?: string | null;
  /** The repository has never been synced: say so instead of "No README found". */
  readonly awaitingSync?: boolean;
}

export function ReadmeSection({ readme, path = null, awaitingSync = false }: ReadmeSectionProps) {
  return (
    <section
      aria-labelledby="readme-heading"
      data-testid="readme-section"
      className="min-w-0 rounded-lg border border-border bg-card p-6 text-card-foreground"
    >
      <h2
        id="readme-heading"
        className="flex flex-wrap items-baseline gap-x-3 text-xl font-semibold"
      >
        README
        {readme.status !== "missing" && path !== null && path !== "" ? (
          <span className="text-sm font-normal break-all text-muted-foreground">{path}</span>
        ) : null}
      </h2>

      {readme.status === "missing" ? (
        <div data-testid="readme-empty" className="mt-3 text-muted-foreground">
          {awaitingSync ? (
            <p>The README appears here after the first sync.</p>
          ) : (
            <>
              <p className="font-medium text-foreground">No README found</p>
              <p className="mt-1">
                This repository has no README in its root folder. Add a{" "}
                <code className="font-mono">README.md</code> to the root of the default branch and
                it will be shown here after the next sync.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {readme.notice !== undefined ? (
            <p
              data-testid="readme-notice"
              className="mt-3 rounded-md bg-warning p-3 text-sm text-warning-foreground"
            >
              {readme.notice}
            </p>
          ) : null}
          <div className="mt-4" data-testid="readme-body">
            {readme.status === "rendered" ? (
              <MermaidEnhancer>
                <CodeCopyEnhancer>
                  <div
                    className="markdown-body"
                    dangerouslySetInnerHTML={{ __html: readme.html }}
                  />
                </CodeCopyEnhancer>
              </MermaidEnhancer>
            ) : (
              <pre
                data-testid="readme-plain"
                tabIndex={0}
                className="overflow-x-auto rounded-md border border-border bg-code-background p-3 font-mono text-sm whitespace-pre-wrap text-code-foreground [overflow-wrap:anywhere]"
              >
                {readme.text}
              </pre>
            )}
          </div>
        </>
      )}
    </section>
  );
}
