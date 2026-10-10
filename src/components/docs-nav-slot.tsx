import { documentCountLabel } from "./repo-card";

/**
 * PLACEHOLDER for the docs table of contents (task 9.6 replaces the body of this component).
 *
 * The repository page layout (`src/app/[owner]/[repo]/page.tsx`) is final: this is the
 * `<nav aria-label="Documentation">` landmark in the sidebar, above the code owners panel. 9.6
 * keeps the landmark, its label, the `Documentation` h2 (`id="docs-nav-heading"`) and the
 * `data-testid="docs-nav"`, and puts the collapsible folder tree where the document count is now.
 * Until then it shows the heading and how many documents were synced.
 */
export interface DocsNavSlotProps {
  readonly docCount: number;
}

export function DocsNavSlot({ docCount }: DocsNavSlotProps) {
  return (
    <nav
      aria-label="Documentation"
      data-testid="docs-nav"
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <h2 id="docs-nav-heading" className="text-lg font-semibold">
        Documentation
      </h2>
      <p data-testid="docs-nav-count" className="mt-1 text-sm text-muted-foreground">
        {documentCountLabel(docCount)}
      </p>
    </nav>
  );
}
