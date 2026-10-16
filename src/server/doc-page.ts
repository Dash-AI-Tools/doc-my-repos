import "server-only";

import {
  buildDocsTree,
  adjacentInTree,
  ancestorFolders,
  resolveDocRoute,
  type DocsTreeDoc,
  type DocsTreeFolder,
} from "@/lib/docs-tree";
import { githubBlobUrl } from "@/lib/github-links";
import { buildOutline, startsWithTitleHeading, type OutlineItem } from "@/lib/outline";
import type { NavView } from "@/lib/reading-prefs";
import { docPathCandidates, docRouteStem, docUrl } from "@/lib/routes";
import { parseTocFilters, type TocData, type TocFilterState } from "@/lib/toc-filters";

import { type Db, getDb } from "./db/client";
import { expectedFailureKind } from "./home";
import { rehypeHighlight } from "./markdown/highlight";
import {
  RENDER_FAILED_WARNING,
  RENDER_TRUNCATED_WARNING,
  renderMarkdown,
  type RenderResult,
} from "./markdown/pipeline";
import { anchorId } from "./markdown/sanitize";
import { getDocsTree, getDocumentByPath, getRepo, type DocumentDetail } from "./queries";
import type { RepoDetail } from "./queries";
import { isRepoRoute } from "./repo-page";
import { loadToc } from "./toc-data";
import { logger, type LogFn } from "./log";

/**
 * Data for the document page `/<owner>/<repo>/docs/<path>` (task 9.7). Reads only through the
 * shared query layer (`getRepo`, `getDocumentByPath`, `getDocsTree`); never GitHub. The Markdown
 * is rendered here, on the server, from the stored body with the same options as the README
 * (link and image rewriting for this repository, Shiki highlighting); the sanitizer is the last
 * pipeline step.
 *
 * Three reads per request: the repository, the document, and every document row of the
 * repository (the last two in parallel). The rows give the sidebar tree, the previous/next
 * links, the breadcrumb and the `docPaths` set the link resolver needs, so there is no separate
 * `getDocPaths` or `getAdjacentDocs` query: `adjacentInTree` is what `getAdjacentDocs` runs
 * too, so the order is the same.
 *
 * `filters` (the URL's type, tag and status, `parseTocFilters`) only narrow the sidebar of an OKF
 * repository (`navTree`); previous/next follow the whole table of contents, and a repository that
 * is not OKF ignores them (`src/server/toc-data.ts`). `view` (the reader's navigation view) shows
 * an OKF repository's sidebar as the Tree of repository paths; previous/next then follow that
 * order (it is the whole tree), and the breadcrumb keeps the OKF tree's folders and indexes.
 *
 * Outcomes:
 * - `not_found`: invalid or reserved parameters (no query runs), an unknown or hidden
 *   repository, a path that matches no document and no folder index. One outcome for all of
 *   them, so the page reveals nothing about which.
 * - `redirect`: the address is not the canonical one: owner and repository in another case, a
 *   document path in another case (`Guides/SETUP`), or a folder with an `index.md` (`/docs/guides`
 *   leads to `/docs/guides/index`). A file extension in the address (`setup.md`) is not
 *   redirected: it names no document.
 * - `error`: the expected failures of the home page (unusable configuration, unreachable
 *   database); anything else is a bug and propagates to `error.tsx`.
 * - `ok`: see `DocPageOk`.
 */

export type DocBodyView =
  | { readonly status: "rendered"; readonly html: string; readonly hideTitleHeading: boolean }
  | { readonly status: "plain"; readonly text: string };

export interface Crumb {
  readonly label: string;
  /** Root-relative link, or null for a folder without an `index.md`. */
  readonly href: string | null;
}

export interface DocPageOk {
  readonly status: "ok";
  readonly repo: RepoDetail;
  /** Everything about the document except its body (rendered into `body`). */
  readonly doc: Omit<DocumentDetail, "body">;
  readonly body: DocBodyView;
  /** Fixed text for the user when the body is not shown as the author wrote it. */
  readonly notice: string | null;
  /** "On this page" entries from the render result; empty when the body is plain text. */
  readonly outline: readonly OutlineItem[];
  /** The repository's whole table of contents (breadcrumb, redirects; previous/next in OKF). */
  readonly tree: DocsTreeFolder;
  /**
   * The sidebar's table of contents: `tree` narrowed by the type, tag and status filters of the
   * URL when the repository is OKF (the document being read stays in it), else `tree`. In the
   * Tree view, the whole tree in repository path order.
   */
  readonly navTree: DocsTreeFolder;
  /** The filter controls' data; null for a repository that is not OKF (no OKF UI) or in Tree. */
  readonly toc: TocData | null;
  /** The navigation view shown; null for a repository that is not OKF (no selector). */
  readonly view: NavView | null;
  readonly previous: DocsTreeDoc | null;
  readonly next: DocsTreeDoc | null;
  /** Folders above the document, outermost first. */
  readonly crumbs: readonly Crumb[];
  /** Link to the source file on GitHub, or null when the stored path is not linkable. */
  readonly sourceUrl: string | null;
  /** In-app URL of this page (the canonical address). */
  readonly url: string;
  readonly loadedAt: Date;
}

export type DocPageData =
  | DocPageOk
  | { readonly status: "redirect"; readonly to: string }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface DocPageDeps {
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
  readonly db?: () => Db;
  readonly now?: () => Date;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
  /** Default: `renderMarkdown`. Replaceable in tests to prove the failure fallback. */
  readonly render?: (
    source: string,
    options: Parameters<typeof renderMarkdown>[1],
  ) => Promise<RenderResult>;
}

export const DOC_RENDER_FAILED_NOTICE =
  "This document could not be rendered, so it is shown as plain text.";
export const DOC_RENDER_TRUNCATED_NOTICE =
  "This document is very long: only the first part is shown. See the full file on GitHub.";

function crumbsFor(tree: DocsTreeFolder, repo: RepoDetail, docPath: string): Crumb[] {
  return ancestorFolders(tree, docPath).map((folder) => ({
    label: folder.name,
    href:
      folder.index === null
        ? null
        : docUrl(repo.owner, repo.name, folder.index.path, repo.docsPath),
  }));
}

export async function loadDocPage(
  owner: string,
  name: string,
  segments: readonly string[],
  deps: DocPageDeps = {},
  filters: TocFilterState = parseTocFilters({}),
  view: NavView = "okf",
): Promise<DocPageData> {
  if (!isRepoRoute(owner, name) || segments.length === 0) return { status: "not_found" };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db ?? (() => getDb().db);
  const render = deps.render ?? renderMarkdown;
  try {
    const handle = db();
    const repo = await getRepo(handle, owner, name);
    if (repo === null) return { status: "not_found" };
    const candidates = docPathCandidates(repo.docsPath, segments);
    if (candidates.length === 0) return { status: "not_found" };

    const [found, rows] = await Promise.all([
      getDocumentByPath(handle, { id: repo.id }, candidates),
      getDocsTree(handle, { id: repo.id }),
    ]);
    const tree = buildDocsTree(rows, repo.docsPath);

    if (found === null) {
      const target = resolveDocRoute(tree, segments);
      const to = target === null ? null : docUrl(repo.owner, repo.name, target.path, repo.docsPath);
      return to === null ? { status: "not_found" } : { status: "redirect", to };
    }

    const url = docUrl(repo.owner, repo.name, found.path, repo.docsPath);
    const stem = docRouteStem(found.path, repo.docsPath);
    if (url === null || stem === null) return { status: "not_found" };
    if (repo.owner !== owner || repo.name !== name || stem !== segments.join("/")) {
      return { status: "redirect", to: url };
    }

    const { body: source, ...doc } = found;
    const rendered = await renderBody(source, found, repo, new Set(rows.map((r) => r.path)), {
      render,
      log,
    });
    const nav = repo.isOkf
      ? await loadToc(handle, repo, rows, filters, found.path, view)
      : { tree, toc: null, view: null };
    const around = adjacentInTree(nav.view === "tree" ? nav.tree : tree, found.path);
    return {
      status: "ok",
      repo,
      doc,
      body: rendered.body,
      notice: rendered.notice,
      outline: rendered.outline,
      tree,
      navTree: nav.tree,
      toc: nav.toc,
      view: nav.view,
      previous: around?.previous ?? null,
      next: around?.next ?? null,
      crumbs: crumbsFor(tree, repo, found.path),
      sourceUrl: githubBlobUrl(repo.htmlUrl, repo.owner, repo.name, repo.defaultBranch, found.path),
      url,
      loadedAt: now(),
    };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("doc_page.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}

interface RenderedBody {
  readonly body: DocBodyView;
  readonly notice: string | null;
  readonly outline: OutlineItem[];
}

async function renderBody(
  source: string,
  doc: DocumentDetail,
  repo: RepoDetail,
  docPaths: ReadonlySet<string>,
  deps: {
    render: NonNullable<DocPageDeps["render"]>;
    log: LogFn;
  },
): Promise<RenderedBody> {
  const plain: RenderedBody = {
    body: { status: "plain", text: source },
    notice: DOC_RENDER_FAILED_NOTICE,
    outline: [],
  };
  try {
    const result = await deps.render(source, {
      links: {
        owner: repo.owner,
        repo: repo.name,
        defaultBranch: repo.defaultBranch,
        docsFolder: repo.docsPath,
        path: doc.path,
        docPaths,
      },
      slots: { highlight: [rehypeHighlight] },
    });
    if (result.warnings.includes(RENDER_FAILED_WARNING)) {
      deps.log("doc_page.render_plain_text", { reason: "renderer_fallback" });
      return plain;
    }
    return {
      body: {
        status: "rendered",
        html: result.html,
        hideTitleHeading: startsWithTitleHeading(result.html, result.headings, doc.title),
      },
      notice: result.warnings.includes(RENDER_TRUNCATED_WARNING)
        ? DOC_RENDER_TRUNCATED_NOTICE
        : null,
      outline: buildOutline(result.headings, anchorId),
    };
  } catch {
    deps.log("doc_page.render_plain_text", { reason: "render_error" });
    return plain;
  }
}
