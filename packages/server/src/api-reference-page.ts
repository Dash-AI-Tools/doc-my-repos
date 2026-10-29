import "server-only";

import { githubBlobUrl } from "@docmyrepos/core/internal/github-links";
import { apiReferenceUrl, apiSpecPathFromSegments } from "@docmyrepos/core/internal/routes";

import { type DbSource } from "./db/client";
import { expectedFailureKind } from "./home";
import { getApiSpec, getRepo, type ApiSpecDetail, type RepoDetail } from "./queries";
import { MEMBER, filterFor, type Reader } from "./queries/visibility";
import { isRepoRoute } from "./repo-page";
import { logger, type LogFn } from "./log";

/**
 * Data for the API reference page `/<owner>/<repo>/api-reference/<spec path>` (openapi-reference
 * design decisions 8 and 9). Reads only through the shared query layer (`getRepo`, `getApiSpec`);
 * never GitHub. The stored spec object is untrusted and is handed to the client widget as is.
 *
 * Outcomes:
 * - `not_found`: invalid or reserved parameters (no query runs), an unknown or hidden repository,
 *   or a path that matches no stored spec. One outcome for all of them.
 * - `redirect`: the address is not the canonical one: owner and repository in another case, or
 *   a spec path in another case.
 * - `error`: the expected failures of the home page; anything else propagates to `error.tsx`.
 * - `ok`: see `ApiReferenceOk`.
 */

export interface ApiReferenceOk {
  readonly status: "ok";
  readonly repo: RepoDetail;
  /**
   * The stored spec: `title`, `apiVersion`, `format` and `specVersion` for the header, `path`,
   * and `spec`, the parsed document for the widget.
   */
  readonly spec: ApiSpecDetail;
  /** "View source on GitHub" link, or null when the stored path is not linkable. */
  readonly sourceUrl: string | null;
  /** In-app URL of this page (the canonical address). */
  readonly url: string;
  readonly loadedAt: Date;
}

export type ApiReferenceData =
  | ApiReferenceOk
  | { readonly status: "redirect"; readonly to: string }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface ApiReferenceDeps {
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
}

export async function loadApiReference(
  owner: string,
  name: string,
  segments: readonly string[],
  deps: ApiReferenceDeps,
): Promise<ApiReferenceData> {
  if (!isRepoRoute(owner, name)) return { status: "not_found" };
  const specPath = apiSpecPathFromSegments(segments);
  if (specPath === null) return { status: "not_found" };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db;
  try {
    const handle = await db();
    const options = { visibility: filterFor(deps.reader ?? MEMBER) };
    const repo = await getRepo(handle, owner, name, options);
    if (repo === null) return { status: "not_found" };
    const spec = await getApiSpec(handle, { id: repo.id }, specPath, options);
    if (spec === null) return { status: "not_found" };
    const url = apiReferenceUrl(repo.owner, repo.name, spec.path);
    if (url === null) return { status: "not_found" };
    if (repo.owner !== owner || repo.name !== name || spec.path !== specPath) {
      return { status: "redirect", to: url };
    }
    return {
      status: "ok",
      repo,
      spec,
      sourceUrl: githubBlobUrl(repo.htmlUrl, repo.owner, repo.name, repo.defaultBranch, spec.path),
      url,
      loadedAt: now(),
    };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("api_reference.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}
