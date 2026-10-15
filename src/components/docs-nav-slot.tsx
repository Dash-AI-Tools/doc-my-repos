import Link from "next/link";

import {
  fileLabel,
  flattenDocsTree,
  toNavTree,
  type DocsTreeDoc,
  type DocsTreeFolder,
} from "@/lib/docs-tree";
import type { NavView } from "@/lib/reading-prefs";
import { docUrl } from "@/lib/routes";
import { withFilterQuery, type TocFilterView } from "@/lib/toc-filters";

import { DocsTree } from "./docs-tree";
import { NavViewSelector } from "./nav-view-selector";
import { OkfFilters } from "./okf-filters";
import { documentCountLabel } from "./repo-card";

/**
 * The `<nav aria-label="Documentation">` landmark: the docs table of contents (tasks 9.3 and 9.6).
 *
 * The left column of the reading pages (document and repository), or the slide-in panel below
 * `lg` (`DocNavPanel` owns that behavior). A plain "Documentation" label (not a heading: it sits
 * beside the content and a heading level here could skip one), optionally the document count
 * (`showCount`, the repository page), then the filters and the tree. No height limit of its own:
 * the column or panel scrolls as a whole.
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
 *
 * Navigation views (docs-nav-views): `view` is null for a repository that is not OKF (no
 * selector). Otherwise the OKF / Tree selector comes first in the landmark, above the label (in
 * the slide-in panel: right under its Close button). In Tree, `tree` is the path-ordered tree
 * (`buildPathTree`, built by the loader) and `filters` is null: pages are labeled by file name
 * (`fileLabel`), with no "Change log" label. The tree is keyed by the view too, so a switch resets
 * the open folders (those holding the current page open again).
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
  /** Show the "N documents" line under the label (the repository page). */
  readonly showCount?: boolean;
  /** The OKF filter controls; null/absent for a repository that is not OKF. */
  readonly filters?: TocFilterView | null;
  /**
   * The repository is OKF: its `log.md` carries the "Change log" label in the tree (task 11.6).
   * Separate from `filters`, which is null for an OKF repository with no type, tag or status.
   */
  readonly okf?: boolean;
  /** The navigation view shown; null/absent for a repository that is not OKF (no selector). */
  readonly view?: NavView | null;
}

const TREE_ID = "docs-tree";

export const CHANGE_LOG_LABEL = "Change log";

function NavBody({
  docCount,
  tree,
  owner,
  repo,
  currentPath,
  awaitingSync,
  showCount,
  filters,
  okf,
  view,
}: Required<Omit<DocsNavSlotProps, "currentPath" | "filters" | "view">> & {
  currentPath: string | null;
  filters: TocFilterView | null;
  view: NavView | null;
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
  // OKF repositories only: `log.md` is a change log, not a
  // typed concept, so it carries that label in the tree instead of a type.
  // In Tree every file is just a file: no label, and its name instead of its title.
  const isTree = view === "tree";
  const labelFor = (doc: DocsTreeDoc): string | null =>
    okf && !isTree && doc.reserved === "log" ? CHANGE_LOG_LABEL : null;
  const titleFor = isTree ? (doc: DocsTreeDoc) => fileLabel(doc.path) : undefined;
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
      {showCount ? (
        <p data-testid="docs-nav-count" className="mt-1 text-sm text-muted-foreground">
          {documentCountLabel(docCount)}
        </p>
      ) : null}
      {filters !== null ? (
        // A Hairline rule closes the filters, so they read apart from the structure below.
        <div data-testid="okf-filters-section" className="border-b border-border pb-4">
          <OkfFilters view={filters} />
        </div>
      ) : null}
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
          // A new filter or view is a new tree: closed or opened folders of the old one mean nothing.
          key={`${view ?? ""}:${query}`}
          tree={toNavTree(tree, hrefFor, labelFor, titleFor)}
          currentPath={currentPath}
          id={TREE_ID}
          expandAll={filtered}
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
  showCount = false,
  filters = null,
  okf = false,
  view = null,
}: DocsNavSlotProps) {
  const body = (
    <NavBody
      docCount={docCount}
      tree={tree}
      owner={owner}
      repo={repo}
      currentPath={currentPath}
      awaitingSync={awaitingSync}
      showCount={showCount}
      filters={filters}
      okf={okf}
      view={view}
    />
  );
  return (
    <nav aria-label="Documentation" data-testid="docs-nav" className="min-w-0 text-card-foreground">
      {view === null ? null : <NavViewSelector view={view} />}
      <p className="text-base font-bold">Documentation</p>
      {body}
    </nav>
  );
}
