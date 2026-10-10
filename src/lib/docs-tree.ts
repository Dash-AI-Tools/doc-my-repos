/**
 * The docs table of contents as a tree (spec repo-space "Docs table of contents"), built from the
 * flat rows `getDocsTree` returns (`src/server/queries/documents.ts`). Pure: no React, no
 * database, no server-only code, so a client component (the collapsible tree, task 9.6) and the
 * server (previous/next links, task 9.7) build the same tree.
 *
 * Ordering ("ordered by folder then title"): read literally, documents sort by their folder and
 * then by title. As a tree that is a pre-order walk: in each folder its own `index.md` comes
 * first (it is the folder entry, not a child), then the folder's documents by title, then its
 * subfolders by name, each subfolder expanded in place. `flattenDocsTree` returns exactly that
 * order, and previous/next links follow it.
 *
 * Decisions the spec leaves open (logged for task 9.1):
 * - A folder's label is its name as stored (case kept); its `index.md`, when present, is the
 *   link target and its description the summary.
 * - `log.md` (the reserved change log) stays in the tree as an ordinary page but sorts after the
 *   folder's other documents: it is history, not content.
 * - Text compares with a fixed collator (`en`, numeric, base sensitivity: `2-setup` before
 *   `10-tuning`, `alpha` next to `Alpha`), then by code point, then by path, so the order is total
 *   and the same on server and client.
 * - Rows outside the docs folder, or whose path does not map to a page (`docRouteStem` null), are
 *   dropped: they have no URL to link to.
 */

import { docRouteStem } from "./routes";

/** Reserved OKF file kinds, as stored in `documents.reserved`. */
export type DocsTreeReserved = "index" | "log";

/** One stored document as the tree needs it. */
export interface DocsTreeRow {
  /** Repo-relative path, as stored (`docs/guides/setup.md`). */
  readonly path: string;
  readonly title: string;
  readonly description: string | null;
  /** OKF facets, kept so a type/tag/status filter (group 11) can narrow the rows first. */
  readonly type: string | null;
  readonly tags: readonly string[];
  readonly status: string | null;
  readonly reserved: DocsTreeReserved | null;
}

export interface DocsTreeDoc extends DocsTreeRow {
  readonly kind: "doc";
  /** Route stem below the docs folder (`guides/setup`); `docUrl` builds the full URL. */
  readonly stem: string;
  /** Last path segment (`setup.md`). */
  readonly fileName: string;
}

export interface DocsTreeFolder {
  readonly kind: "folder";
  /** Folder name as stored; empty for the docs root. */
  readonly name: string;
  /** Repo-relative folder path (`docs/guides`); the docs folder itself for the root. */
  readonly path: string;
  /** The folder's `index.md`: the folder entry links to it. */
  readonly index: DocsTreeDoc | null;
  /** The index document's description, shown as the folder summary. */
  readonly summary: string | null;
  /** Documents (by title, `log.md` last), then subfolders (by name). */
  readonly children: readonly DocsTreeNode[];
}

export type DocsTreeNode = DocsTreeDoc | DocsTreeFolder;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Total order on display text: collator, then code point. */
export function compareTreeText(a: string, b: string): number {
  const byCollator = collator.compare(a, b);
  if (byCollator !== 0) return byCollator;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareDocs(a: DocsTreeDoc, b: DocsTreeDoc): number {
  const aLog = a.reserved === "log" ? 1 : 0;
  const bLog = b.reserved === "log" ? 1 : 0;
  if (aLog !== bLog) return aLog - bLog;
  return compareTreeText(a.title, b.title) || compareTreeText(a.path, b.path);
}

interface MutableFolder {
  name: string;
  path: string;
  indexCandidates: DocsTreeDoc[];
  docs: DocsTreeDoc[];
  folders: Map<string, MutableFolder>;
}

function newFolder(name: string, path: string): MutableFolder {
  return { name, path, indexCandidates: [], docs: [], folders: new Map() };
}

/** The folder index: the exact `index.md` first, then other spellings (`INDEX.md`) by path. */
function pickIndex(candidates: DocsTreeDoc[]): DocsTreeDoc | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const aExact = a.fileName === "index.md" ? 0 : 1;
    const bExact = b.fileName === "index.md" ? 0 : 1;
    return aExact - bExact || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return sorted[0] ?? null;
}

function freeze(folder: MutableFolder): DocsTreeFolder {
  const index = pickIndex(folder.indexCandidates);
  // A second index spelling in the same folder is listed as an ordinary page.
  const docs = [...folder.docs, ...folder.indexCandidates.filter((d) => d !== index)].sort(
    compareDocs,
  );
  const folders = [...folder.folders.values()]
    .map(freeze)
    .sort((a, b) => compareTreeText(a.name, b.name) || compareTreeText(a.path, b.path));
  return {
    kind: "folder",
    name: folder.name,
    path: folder.path,
    index,
    summary: index?.description ?? null,
    children: [...docs, ...folders],
  };
}

/**
 * Builds the ordered tree for one repository. `docsFolder` is `repos.docs_path`; with no docs
 * folder there are no pages, so the root is empty.
 */
export function buildDocsTree(
  rows: readonly DocsTreeRow[],
  docsFolder: string | null | undefined,
): DocsTreeFolder {
  const folderPath = typeof docsFolder === "string" ? docsFolder : "";
  const root = newFolder("", folderPath);
  if (folderPath === "") return freeze(root);

  for (const row of rows) {
    const stem = docRouteStem(row.path, folderPath);
    if (stem === null) continue;
    const relative = row.path.slice(folderPath.length + 1);
    const segments = relative.split("/");
    const fileName = segments.pop() ?? relative;
    let folder = root;
    for (const segment of segments) {
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = newFolder(segment, `${folder.path}/${segment}`);
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    const doc: DocsTreeDoc = {
      kind: "doc",
      path: row.path,
      title: row.title,
      description: row.description,
      type: row.type,
      tags: row.tags,
      status: row.status,
      reserved: row.reserved,
      stem,
      fileName,
    };
    if (row.reserved === "index") folder.indexCandidates.push(doc);
    else folder.docs.push(doc);
  }
  return freeze(root);
}

/** Every document in table-of-contents order (each folder's index first). */
export function flattenDocsTree(tree: DocsTreeFolder): DocsTreeDoc[] {
  const out: DocsTreeDoc[] = [];
  const walk = (folder: DocsTreeFolder) => {
    if (folder.index !== null) out.push(folder.index);
    for (const child of folder.children) {
      if (child.kind === "doc") out.push(child);
      else walk(child);
    }
  };
  walk(tree);
  return out;
}

/** The documents before and after `path` in table-of-contents order. */
export function adjacentInTree(
  tree: DocsTreeFolder,
  path: string,
): { previous: DocsTreeDoc | null; next: DocsTreeDoc | null } | null {
  const flat = flattenDocsTree(tree);
  const at = flat.findIndex((d) => d.path === path);
  if (at === -1) return null;
  return { previous: flat[at - 1] ?? null, next: flat[at + 1] ?? null };
}

/** The folders from the first level down to the one that holds `path`, outermost first. */
export function ancestorFolders(tree: DocsTreeFolder, path: string): DocsTreeFolder[] {
  const trail: DocsTreeFolder[] = [];
  let folder = tree;
  for (;;) {
    const next: DocsTreeFolder | undefined = folder.children.find(
      (child): child is DocsTreeFolder =>
        child.kind === "folder" && path.startsWith(`${child.path}/`),
    );
    if (next === undefined) return trail;
    trail.push(next);
    folder = next;
  }
}

function lowerStem(value: string): string {
  return value.toLowerCase();
}

/**
 * Finds the page a documentation address stands for when no document is stored at exactly that
 * address (task 9.7). `segments` are the decoded catch-all segments after `/docs/`.
 *
 * 1. A document whose route stem equals the segments ignoring case (`Guides/SETUP` for
 *    `guides/setup`). Several matches: the lowest path by code point, so the answer is stable.
 * 2. A folder with that path (case ignored) that has an `index.md`: the folder's index document,
 *    so `/docs/guides` leads to `/docs/guides/index`.
 *
 * Returns null when neither exists. Pure, so the page can redirect to the stored spelling.
 */
export function resolveDocRoute(
  tree: DocsTreeFolder,
  segments: readonly string[],
): DocsTreeDoc | null {
  if (segments.length === 0) return null;
  const wanted = lowerStem(segments.join("/"));
  const flat = flattenDocsTree(tree);
  const byStem = flat
    .filter((doc) => lowerStem(doc.stem) === wanted)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (byStem[0] !== undefined) return byStem[0];

  const folders: DocsTreeFolder[] = [];
  const walk = (folder: DocsTreeFolder) => {
    for (const child of folder.children) {
      if (child.kind !== "folder") continue;
      folders.push(child);
      walk(child);
    }
  };
  walk(tree);
  const prefix = `${tree.path}/`;
  const matches = folders
    .filter(
      (f) =>
        f.index !== null &&
        f.path.startsWith(prefix) &&
        lowerStem(f.path.slice(prefix.length)) === wanted,
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return matches[0]?.index ?? null;
}

/** Number of folders below the docs root (every level). */
export function countFolders(tree: DocsTreeFolder): number {
  let count = 0;
  const walk = (folder: DocsTreeFolder) => {
    for (const child of folder.children) {
      if (child.kind !== "folder") continue;
      count += 1;
      walk(child);
    }
  };
  walk(tree);
  return count;
}

/** A page in the navigation tree the browser gets (`toNavTree`): only what the tree shows. */
export interface NavDoc {
  readonly kind: "doc";
  readonly title: string;
  /** Repo-relative path, to find the current page. */
  readonly path: string;
  readonly href: string;
}

/** A folder in the navigation tree. */
export interface NavFolder {
  readonly kind: "folder";
  /** Folder name as stored; empty for the docs root. */
  readonly name: string;
  /** Repo-relative folder path, unique in the tree. */
  readonly path: string;
  /** Link of the folder's `index.md`, or null when it has none. */
  readonly href: string | null;
  /** Repo-relative path of the folder's `index.md`, to mark it as the current page. */
  readonly indexPath: string | null;
  /** The index's description. */
  readonly summary: string | null;
  readonly children: readonly NavNode[];
}

export type NavNode = NavDoc | NavFolder;

/**
 * The slim form of the tree that goes to the browser (task 9.6): titles, links and summaries, with
 * the link of every page already built (`hrefFor` returns null for a page that has no URL; such
 * a page is left out). The root's own `index.md` becomes its first child, since the root has no
 * folder row to link from. Pure; keeps the order of `buildDocsTree`.
 */
export function toNavTree(
  tree: DocsTreeFolder,
  hrefFor: (doc: DocsTreeDoc) => string | null,
): NavFolder {
  const doc = (d: DocsTreeDoc): NavDoc | null => {
    const href = hrefFor(d);
    return href === null ? null : { kind: "doc", title: d.title, path: d.path, href };
  };
  const folder = (f: DocsTreeFolder, isRoot: boolean): NavFolder => {
    const children: NavNode[] = [];
    const lead = isRoot && f.index !== null ? doc(f.index) : null;
    if (lead !== null) children.push(lead);
    for (const child of f.children) {
      if (child.kind === "folder") children.push(folder(child, false));
      else {
        const d = doc(child);
        if (d !== null) children.push(d);
      }
    }
    const index = isRoot || f.index === null ? null : doc(f.index);
    return {
      kind: "folder",
      name: f.name,
      path: f.path,
      href: index?.href ?? null,
      indexPath: index?.path ?? null,
      summary: index === null ? null : f.summary,
      children,
    };
  };
  return folder(tree, true);
}
