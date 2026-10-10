import Link from "next/link";

import { flattenDocsTree, toNavTree, type DocsTreeDoc, type DocsTreeFolder } from "@/lib/docs-tree";
import { docUrl } from "@/lib/routes";
import { withFilterQuery, type TocFilterView } from "@/lib/toc-filters";

import { DocsTree } from "./docs-tree";
import { OkfFilters } from "./okf-filters";
import { documentCountLabel } from "./repo-card";
import { ResponsiveDetails } from "./responsive-details";

/**
 * The `<nav aria-label="Documentation">` landmark: the docs table of contents (tasks 9.3 and 9.6).
 *
 * Used twice:
 * - `card` (default): the repository page's sidebar card. `h2#docs-nav-heading`, the document
 *   count, expand/collapse buttons and the tree, which scrolls inside the card when it is long.
 * - `sidebar`: the document page's sidebar. The same landmark, but collapsible on small screens
 *   (open on large ones), without a heading of its own (the summary is the label) and without a
 *   height limit of its own: the sidebar scrolls as a whole.
 *
 * States, kept distinct on purpose:
 * - the repository has never been synced (`awaitingSync`): the table of contents "appears after
 *   the first sync";
 * - synced, but no Markdown file under a docs folder: "No documentation files found", with the
 *   hint for adding some;
 * - otherwise the tree, with `currentPath` (a document page) marked and its folders open.
 *
 * OKF filters (tasks 11.2 and 11.3): `filters` is the view of the type, tag and status controls,
 * present only for an OKF repository (null/absent: nothing OKF renders). They sit above the tree.
 * `tree` is already narrowed by them (the page filters the rows before building it); with a
 * filter selected the tree starts fully open and is re-keyed so the open set resets, its links
 * carry the filters (so they survive moving between documents), and a selection that matches
 * nothing says so with a way to clear it instead of the "no documentation files" state.
 */
export interface DocsNavSlotProps {
  readonly docCount: number;
  readonly tree: DocsTreeFolder;
  readonly owner: string;
  readonly repo: string;
  /** Repo-relative path of the document being read, if any. */
  readonly currentPath?: string | null;
  /** The repository has never been synced. */
  readonly awaitingSync?: boolean;
  readonly variant?: "card" | "sidebar";
  /** The OKF filter controls; null/absent for a repository that is not OKF. */
  readonly filters?: TocFilterView | null;
}

const TREE_ID = "docs-tree";

function NavBody({
  docCount,
  tree,
  owner,
  repo,
  currentPath,
  awaitingSync,
  variant,
  filters,
}: Required<Omit<DocsNavSlotProps, "currentPath" | "filters">> & {
  currentPath: string | null;
  filters: TocFilterView | null;
}) {
  if (awaitingSync) {
    return (
      <p data-testid="docs-nav-pending" className="mt-2 text-sm text-muted-foreground">
        The table of contents appears here after the first sync.
      </p>
    );
  }
  const filtered = filters?.active === true;
  const query = filters?.query ?? "";
  const hrefFor = (doc: DocsTreeDoc): string | null => {
    const href = docUrl(owner, repo, doc.path, tree.path);
    return href === null ? null : withFilterQuery(href, query);
  };
  if (flattenDocsTree(tree).length === 0 && !filtered) {
    return (
      <div data-testid="docs-nav-empty" className="mt-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">No documentation files found</p>
        <p className="mt-1">
          Add Markdown files to a <code className="font-mono">docs/</code> folder (
          <code className="font-mono">doc/</code> and{" "}
          <code className="font-mono">documentation/</code> work too) on the default branch. They
          are listed here after the next sync.
        </p>
      </div>
    );
  }
  return (
    <>
      {variant === "card" ? (
        <p data-testid="docs-nav-count" className="mt-1 text-sm text-muted-foreground">
          {documentCountLabel(docCount)}
        </p>
      ) : null}
      {filters !== null ? <OkfFilters view={filters} /> : null}
      {filters !== null && filters.active && filters.matches === 0 ? (
        <div data-testid="docs-nav-no-match" className="mt-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">No documents match these filters</p>
          <p className="mt-1">
            <Link href={filters.clearHref} prefetch={false} className="text-link">
              Clear filters
            </Link>{" "}
            to see every document.
          </p>
        </div>
      ) : null}
      {flattenDocsTree(tree).length > 0 ? (
        <DocsTree
          // A new filter is a new tree: closed or opened folders of the old one mean nothing.
          key={query}
          tree={toNavTree(tree, hrefFor)}
          currentPath={currentPath}
          id={TREE_ID}
          expandAll={filtered}
          className={variant === "card" ? "max-h-[32rem] overflow-y-auto" : undefined}
        />
      ) : null}
    </>
  );
}

export function DocsNavSlot({
  docCount,
  tree,
  owner,
  repo,
  currentPath = null,
  awaitingSync = false,
  variant = "card",
  filters = null,
}: DocsNavSlotProps) {
  const body = (
    <NavBody
      docCount={docCount}
      tree={tree}
      owner={owner}
      repo={repo}
      currentPath={currentPath}
      awaitingSync={awaitingSync}
      variant={variant}
      filters={filters}
    />
  );
  return (
    <nav
      aria-label="Documentation"
      data-testid="docs-nav"
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      {variant === "sidebar" ? (
        <ResponsiveDetails summary={<span>Documentation</span>}>{body}</ResponsiveDetails>
      ) : (
        <>
          <h2 id="docs-nav-heading" className="text-lg font-semibold">
            Documentation
          </h2>
          {body}
        </>
      )}
    </nav>
  );
}
