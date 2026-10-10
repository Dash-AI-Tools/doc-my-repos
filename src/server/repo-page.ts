import "server-only";

import { isReservedOwner } from "@/lib/routes";

import type { Db } from "./db/client";
import { isValidOwner, isValidRepoName } from "./github/client";
import { expectedFailureKind } from "./home";
import { rehypeHighlight } from "./markdown/highlight";
import {
  RENDER_FAILED_WARNING,
  RENDER_TRUNCATED_WARNING,
  renderMarkdown,
  type RenderResult,
} from "./markdown/pipeline";
import { getDocPaths, getRepo, type RepoDetail } from "./queries";
import { getRuntime } from "./runtime";

/**
 * Data for the repository page `/<owner>/<repo>` (tasks 9.3 and 9.4). Reads only through the shared
 * query layer (`getRepo`, `getDocPaths`); never GitHub. The README is rendered here, on the
 * server, from the stored Markdown with the same options every document uses (link and image
 * rewriting for this repository, Shiki highlighting); the sanitizer is the last pipeline step.
 *
 * Outcomes:
 * - `not_found`: the parameters are not a valid GitHub owner and repository name (checked with
 *   the GitHub client's own rules, so no query runs for `../x` or `a%20b`), the owner is one of
 *   the app's reserved top-level names (`/search/x` is not a repository of "search"), or the
 *   visibility-filtered lookup found nothing.
 * - `error`: the expected failures of the home page (unusable configuration, unreachable
 *   database), shown in-page; anything else is a bug and propagates to `error.tsx`.
 * - `ok`: the repository, its README as a `ReadmeView`.
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
      /** When the data was read; the page formats "x minutes ago" against this. */
      readonly loadedAt: Date;
    }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface RepoPageDeps {
  /** The database to read. Default: the shared runtime's. May throw `ConfigError`. */
  readonly db?: () => Db;
  readonly now?: () => Date;
  /** Receives a fixed message only. Default: `console.error`. */
  readonly log?: (message: string) => void;
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
  log: (message: string) => void,
): Promise<ReadmeView> {
  const readme = repo.readme;
  if (readme === null) return { status: "missing" };
  const plain: ReadmeView = {
    status: "plain",
    text: readme.markdown,
    notice: RENDER_FAILED_NOTICE,
  };
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
      log("[repo-page] the README renderer fell back to plain text");
      return plain;
    }
    return result.warnings.includes(RENDER_TRUNCATED_WARNING)
      ? { status: "rendered", html: result.html, notice: RENDER_TRUNCATED_NOTICE }
      : { status: "rendered", html: result.html };
  } catch {
    log("[repo-page] the README could not be rendered");
    return plain;
  }
}

export async function loadRepoPage(
  owner: string,
  name: string,
  deps: RepoPageDeps = {},
): Promise<RepoPageData> {
  if (!isRepoRoute(owner, name)) return { status: "not_found" };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.error(message));
  const db = deps.db ?? (() => getRuntime().db.db);
  const render = deps.render ?? renderMarkdown;
  try {
    const handle = db();
    const repo = await getRepo(handle, owner, name);
    if (repo === null) return { status: "not_found" };
    const docPaths =
      repo.readme === null ? new Set<string>() : await getDocPaths(handle, { id: repo.id });
    const readme = await readmeView(repo, docPaths, render, log);
    return { status: "ok", repo, readme, loadedAt: now() };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log(`[repo-page] could not load the repository: ${kind}`);
    return { status: "error", loadedAt: now() };
  }
}
