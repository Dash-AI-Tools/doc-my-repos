import "server-only";

import type { DocsTreeFolder } from "@docmyrepos/core/internal/docs-tree";
import { buildOutline, type OutlineItem } from "@docmyrepos/core/internal/outline";
import type { NavView } from "@docmyrepos/core/internal/reading-prefs";
import { isReservedOwner } from "@docmyrepos/core/internal/routes";
import {
  parseTocFilters,
  type TocData,
  type TocFilterState,
} from "@docmyrepos/core/internal/toc-filters";

import { type DbSource } from "./db/client";
import { isValidOwner, isValidRepoName } from "./github/client";
import { expectedFailureKind } from "./home";
import { rehypeHighlight } from "./markdown/highlight";
import { anchorId } from "./markdown/sanitize";
import {
  RENDER_FAILED_WARNING,
  RENDER_TRUNCATED_WARNING,
  renderMarkdown,
  type RenderResult,
} from "./markdown/pipeline";
import {
  getDocsTree,
  listApiSpecs,
  getRepo,
  getRepoSyncInfo,
  type ApiSpecSummary,
  type RepoDetail,
  type RepoLastRun,
} from "./queries";
import { MEMBER, filterFor, type Reader } from "./queries/visibility";
import { loadToc } from "./toc-data";
import { logger, type LogFn } from "./log";

/**
 * Data for the repository page `/<owner>/<repo>` (tasks 9.3, 9.4 and 9.6). Reads only through the
 * shared query layer (`getRepo`, `getDocsTree`, `listApiSpecs`, `getRepoSyncInfo` for the last sync run of the
 * header, task 12.2); never GitHub. The document rows give both the docs
 * table of contents (`tree`) and the `docPaths` set the README's link resolver needs. The README is rendered here, on the
 * server, from the stored Markdown with the same options every document uses (link and image
 * rewriting for this repository, Shiki highlighting); the sanitizer is the last pipeline step.
 *
 * `filters` are the type, tag and status filters of the URL (`parseTocFilters`). They narrow the
 * table of contents of an OKF repository only; for any other repository they are ignored
 * (`packages/server/src/toc-data.ts`). `view` is the reader's navigation view (OKF or Tree); it too applies
 * to an OKF repository only.
 *
 * Outcomes:
 * - `not_found`: the parameters are not a valid GitHub owner and repository name (checked with
 *   the GitHub client's own rules, so no query runs for `../x` or `a%20b`), the owner is one of
 *   the app's reserved top-level names (`/search/x` is not a repository of "search"), or the
 *   visibility-filtered lookup found nothing.
 * - `error`: the expected failures of the home page (unusable configuration, unreachable
 *   database), shown in-page; anything else is a bug and propagates to `error.tsx`.
 * - `ok`: the repository, its README as a `ReadmeView` and its docs table of contents.
 *
 * A README that cannot be rendered never fails the page: the Markdown is shown as plain text with
 * a notice. The log line is fixed text; the README is never quoted.
 */

/** Shape the page's `ReadmeSection` takes (`ReadmeViewData` in the component, same fields). */
export type ReadmeView =
  | { readonly status: "rendered"; readonly html: string; readonly notice?: string }
  | { readonly status: "plain"; readonly text: string; readonly notice: string }
  | { readonly status: "missing" };

export type RepoPageData =
  | {
      readonly status: "ok";
      readonly repo: RepoDetail;
      readonly readme: ReadmeView;
      /**
       * The README's h2 to h4 headings for the "On this page" list, from the render result so each
       * id exists in the HTML (the same `buildOutline` as the document page). Empty when there is
       * no README, it is shown as plain text, or it has no such headings.
       */
      readonly readmeOutline: readonly OutlineItem[];
      /**
       * The docs table of contents (empty when the repository has no docs folder), narrowed by the
       * type, tag and status filters when the repository is OKF.
       */
      readonly tree: DocsTreeFolder;
      /** The filter controls' data; null for a repository that is not OKF (no OKF UI) or in Tree. */
      readonly toc: TocData | null;
      /** The navigation view shown; null for a repository that is not OKF (no selector). */
      readonly view: NavView | null;
      /** API specs of the repository ordered by path (no spec bodies); empty when none. */
      readonly apiSpecs: readonly ApiSpecSummary[];
      /** The repository's latest recorded sync run (task 12.2); null when none is recorded. */
      readonly lastRun: RepoLastRun | null;
      /** When the data was read; the page formats "x minutes ago" against this. */
      readonly loadedAt: Date;
    }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface RepoPageDeps {
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
  readonly db: DbSource;
  readonly now?: () => Date;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
  /**
   * Who is reading (public access). Default: a signed-in user, who sees every allowed repository.
   * An anonymous visitor reads through the anonymous filter, so only public repositories exist.
   */
  readonly reader?: Reader;
  /** Default: `renderMarkdown`. Replaceable in tests to prove the failure fallback. */
  readonly render?: (
    source: string,
    options: Parameters<typeof renderMarkdown>[1],
  ) => Promise<RenderResult>;
}

export const RENDER_FAILED_NOTICE =
  "This README could not be rendered, so it is shown as plain text.";
export const RENDER_TRUNCATED_NOTICE =
  "This README is very long: only the first part is shown. See the full file on GitHub.";

/** Whether `/<owner>/<repo>` can name a repository at all. No I/O. */
export function isRepoRoute(owner: string, name: string): boolean {
  return isValidOwner(owner) && isValidRepoName(name) && !isReservedOwner(owner);
}

async function readmeView(
  repo: RepoDetail,
  docPaths: ReadonlySet<string>,
  render: NonNullable<RepoPageDeps["render"]>,
  log: LogFn,
): Promise<{ readonly view: ReadmeView; readonly outline: readonly OutlineItem[] }> {
  const readme = repo.readme;
  if (readme === null) return { view: { status: "missing" }, outline: [] };
  const plain = {
    view: { status: "plain", text: readme.markdown, notice: RENDER_FAILED_NOTICE },
    outline: [],
  } satisfies { view: ReadmeView; outline: readonly OutlineItem[] };
  try {
    const result = await render(readme.markdown, {
      links: {
        owner: repo.owner,
        repo: repo.name,
        defaultBranch: repo.defaultBranch,
        docsFolder: repo.docsPath,
        path: readme.path,
        docPaths,
      },
      slots: { highlight: [rehypeHighlight] },
    });
    if (result.warnings.includes(RENDER_FAILED_WARNING)) {
      log("repo_page.readme_plain_text", { reason: "renderer_fallback" });
      return plain;
    }
    const outline = buildOutline(result.headings, anchorId);
    return {
      view: result.warnings.includes(RENDER_TRUNCATED_WARNING)
        ? { status: "rendered", html: result.html, notice: RENDER_TRUNCATED_NOTICE }
        : { status: "rendered", html: result.html },
      outline,
    };
  } catch {
    log("repo_page.readme_plain_text", { reason: "render_error" });
    return plain;
  }
}

export async function loadRepoPage(
  owner: string,
  name: string,
  deps: RepoPageDeps,
  filters: TocFilterState = parseTocFilters({}),
  view: NavView = "okf",
): Promise<RepoPageData> {
  if (!isRepoRoute(owner, name)) return { status: "not_found" };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db;
  const render = deps.render ?? renderMarkdown;
  try {
    const handle = await db();
    const options = { visibility: filterFor(deps.reader ?? MEMBER) };
    const repo = await getRepo(handle, owner, name, options);
    if (repo === null) return { status: "not_found" };
    const rows = await getDocsTree(handle, { id: repo.id }, options);
    const {
      tree,
      toc,
      view: shown,
    } = await loadToc(handle, repo, rows, filters, null, view, options);
    const { view: readme, outline: readmeOutline } = await readmeView(
      repo,
      new Set(rows.map((r) => r.path)),
      render,
      log,
    );
    const apiSpecs = await listApiSpecs(handle, { id: repo.id }, options);
    const sync = await getRepoSyncInfo(handle, { id: repo.id }, options);
    return {
      status: "ok",
      repo,
      readme,
      readmeOutline,
      tree,
      toc,
      view: shown,
      apiSpecs,
      lastRun: sync?.lastRun ?? null,
      loadedAt: now(),
    };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("repo_page.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}
