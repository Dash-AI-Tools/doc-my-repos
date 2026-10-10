"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NavFolder, NavNode } from "@/lib/docs-tree";

import { revealInScroller } from "./reveal-in-scroller";

/**
 * The collapsible docs table of contents (task 9.6, spec "Docs table of contents").
 *
 * A client component with ONE piece of state: the set of open folder paths. It is not built from
 * native `<details>` because a folder with an `index.md` must be a link (spec "Folder index"), and
 * a link inside a `<summary>` is nested interactive content (axe `nested-interactive`, and the
 * click would both follow the link and fight the toggle). Instead each folder row is a disclosure
 * button (`aria-expanded`, `aria-controls`) and, for a folder with an index, a link next to it.
 * Buttons and links are real focusable elements, so Tab, Enter and Space work with no extra code.
 *
 * - The server renders the right folders open already (the same initial state is computed from the
 *   same props), so there is no flash; collapsed lists are `hidden`. The cost: without JavaScript
 *   a collapsed folder cannot be opened. Documents stay reachable through search and links.
 * - Order and labels come from `buildDocsTree` (`src/lib/docs-tree.ts`): each folder's own
 *   `index.md` first (as the folder row itself), then documents by title, then subfolders by name.
 * - A folder with an `index.md` links to it and shows the index's description as a summary; the
 *   index is not repeated as a child. A folder without one is just a toggle.
 * - The current page is marked `aria-current="page"`. Its ancestor folders start open, and open
 *   again whenever the current page changes (a soft navigation keeps this component and the
 *   folders the visitor opened). With no current page, top-level folders start open when the
 *   repository has at most `OPEN_ALL_UP_TO` pages (the spec example then shows `Setup` and
 *   `Tuning` at a glance); in a larger repository everything starts closed.
 * - "Expand all" and "Collapse all" change that one set. Re-rendering 2000 entries on a click is
 *   a few milliseconds; there is no per-node state or subscription.
 * - Titles, folder names and descriptions are third-party text: React escapes them. Links are not
 *   prefetched: a long tree would otherwise prefetch every page.
 */

/** Repositories with at most this many pages start with their top-level folders open. */
export const OPEN_ALL_UP_TO = 40;

export interface DocsTreeProps {
  readonly tree: NavFolder;
  /** Repo-relative path of the document being read (`docs/guides/setup.md`), if any. */
  readonly currentPath?: string | null;
  /** DOM id prefix of the tree and its lists. */
  readonly id?: string;
  /** Extra classes for the scrolling area (the repository page limits its height). */
  readonly className?: string;
  /**
   * Start with every folder open. The table of contents narrowed by a filter (task 11.2) is
   * short, and a match hidden in a closed folder would look like a missing one. The parent
   * re-keys the tree when the filter changes, which resets the open set.
   */
  readonly expandAll?: boolean;
}

/** The folder paths on the way to `path`: `docs/a/b/x.md` is in `docs/a` and `docs/a/b`. */
export function ancestorPaths(tree: NavFolder, path: string | null): string[] {
  if (path === null) return [];
  const out: string[] = [];
  let folder = tree;
  for (;;) {
    const next: NavFolder | undefined = folder.children.find(
      (c): c is NavFolder => c.kind === "folder" && path.startsWith(`${c.path}/`),
    );
    if (next === undefined) return out;
    out.push(next.path);
    folder = next;
  }
}

function countPages(node: NavNode): number {
  return node.kind === "doc" ? 1 : node.children.reduce((n, c) => n + countPages(c), 0);
}

function allFolders(folder: NavFolder, into: string[] = []): string[] {
  for (const child of folder.children) {
    if (child.kind !== "folder") continue;
    into.push(child.path);
    allFolders(child, into);
  }
  return into;
}

/** The folders open before the visitor does anything. */
export function initialOpen(
  tree: NavFolder,
  currentPath: string | null,
  expandAll = false,
): Set<string> {
  if (expandAll) return new Set(allFolders(tree));
  const open = new Set(ancestorPaths(tree, currentPath));
  if (countPages(tree) <= OPEN_ALL_UP_TO) {
    for (const child of tree.children) if (child.kind === "folder") open.add(child.path);
  }
  return open;
}

const ROW =
  "block min-w-0 rounded-md px-2 py-1 text-sm no-underline break-words [overflow-wrap:anywhere]";
const LINK = `${ROW} text-foreground hover:bg-muted hover:text-foreground`;
const CURRENT = "bg-accent font-medium text-accent-foreground hover:bg-accent";
const TOGGLE =
  "flex min-w-0 items-start gap-1 rounded-md px-1 py-1 text-left text-sm text-foreground hover:bg-muted";
const BUTTON =
  "rounded-md border border-border bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground hover:bg-accent";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

interface Shared {
  readonly open: ReadonlySet<string>;
  readonly currentPath: string | null;
  readonly listIds: ReadonlyMap<string, string>;
  readonly toggle: (path: string) => void;
}

function PageLink({
  title,
  href,
  path,
  shared,
  label,
}: {
  title: string;
  href: string;
  path: string;
  shared: Shared;
  label?: string;
}) {
  const current = path === shared.currentPath;
  const link = (
    <Link
      href={href}
      prefetch={false}
      aria-current={current ? "page" : undefined}
      className={current ? `${LINK} ${CURRENT}` : LINK}
    >
      {title}
    </Link>
  );
  if (label === undefined) return link;
  // The label sits beside the link, not in it, so the link's name stays the page title.
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <div className="min-w-0">{link}</div>
      <span
        data-testid="docs-tree-label"
        className="mt-1 shrink-0 rounded-full bg-okf-badge px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-okf-badge-foreground"
      >
        {label}
      </span>
    </div>
  );
}

function FolderRow({ folder, shared }: { folder: NavFolder; shared: Shared }) {
  const open = shared.open.has(folder.path);
  const listId = shared.listIds.get(folder.path);
  const toggle = () => shared.toggle(folder.path);
  return (
    <li>
      {folder.href !== null && folder.indexPath !== null ? (
        <div className="flex items-start">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={toggle}
            className="rounded-md px-1 py-1 hover:bg-muted"
          >
            <Chevron open={open} />
            <span className="sr-only">{folder.name}</span>
          </button>
          <div className="-ml-1 min-w-0 flex-1 [&>a]:px-1 [&>a]:font-medium">
            <PageLink
              title={folder.name}
              href={folder.href}
              path={folder.indexPath}
              shared={shared}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
          className={`${TOGGLE} w-full font-medium`}
        >
          <Chevron open={open} />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{folder.name}</span>
        </button>
      )}
      {folder.summary !== null && folder.summary.trim() !== "" ? (
        <p
          data-testid="folder-summary"
          className="line-clamp-2 pl-[1.375rem] text-xs break-words text-muted-foreground"
        >
          {folder.summary}
        </p>
      ) : null}
      <NodeList id={listId} nodes={folder.children} shared={shared} hidden={!open} nested />
    </li>
  );
}

function NodeList({
  id,
  nodes,
  shared,
  hidden = false,
  nested = false,
}: {
  id?: string;
  nodes: readonly NavNode[];
  shared: Shared;
  hidden?: boolean;
  nested?: boolean;
}) {
  return (
    <ul
      id={id}
      role="list"
      hidden={hidden}
      className={nested ? "ml-3 border-l border-border pl-1.5" : undefined}
    >
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <FolderRow key={`d:${node.path}`} folder={node} shared={shared} />
        ) : (
          <li key={`f:${node.path}`}>
            <PageLink
              title={node.title}
              href={node.href}
              path={node.path}
              shared={shared}
              label={node.label}
            />
          </li>
        ),
      )}
    </ul>
  );
}

export function DocsTree({
  tree,
  currentPath = null,
  id = "docs-tree",
  className,
  expandAll = false,
}: DocsTreeProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    initialOpen(tree, currentPath, expandAll),
  );
  const [seenPath, setSeenPath] = useState(currentPath);
  const container = useRef<HTMLDivElement>(null);

  // A new current page (soft navigation): open the folders it is in, keep the rest as they are.
  // Adjusting state while rendering, the pattern React recommends for state derived from props.
  if (seenPath !== currentPath) {
    setSeenPath(currentPath);
    const folders = ancestorPaths(tree, currentPath);
    if (folders.some((p) => !open.has(p))) setOpen(new Set([...open, ...folders]));
  }

  const folders = useMemo(() => allFolders(tree), [tree]);
  const listIds = useMemo(
    () => new Map(folders.map((path, i) => [path, `${id}-f${i}`])),
    [folders, id],
  );
  const toggle = useCallback((path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  // Show the current entry inside a scrolling tree, without moving the page.
  useEffect(() => {
    const current = container.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) revealInScroller(current);
  }, [currentPath]);

  const shared: Shared = { open, currentPath, listIds, toggle };
  return (
    <div data-testid="docs-tree-root">
      {folders.length > 0 ? (
        <div className="mt-2 flex gap-2" data-testid="docs-tree-controls">
          <button
            type="button"
            className={BUTTON}
            aria-controls={id}
            onClick={() => setOpen(new Set(folders))}
          >
            Expand all
          </button>
          <button
            type="button"
            className={BUTTON}
            aria-controls={id}
            onClick={() => setOpen(new Set())}
          >
            Collapse all
          </button>
        </div>
      ) : null}
      <div id={id} ref={container} data-testid="docs-tree" className={`mt-2 ${className ?? ""}`}>
        <NodeList nodes={tree.children} shared={shared} />
      </div>
    </div>
  );
}
