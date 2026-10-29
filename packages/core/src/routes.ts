/**
 * In-app URLs for documents. The ONE place that maps a stored document path to a portal URL
 * and back, so link rewriting (server) and pages (server and client components) cannot drift.
 * Pure: no React, no database, no server-only code.
 *
 * Scheme (spec "Open a document": `/<owner>/<repo>/docs/guides/setup`):
 *
 *   `/{owner}/{repo}/docs/{path below the docs folder, .md/.mdx removed}`
 *
 * - The `docs` segment is the literal word, whatever the repository's docs folder is called
 *   (`doc`, `documentation`, a `docsPath` override).
 * - One URL per document: `guides/index.md` is `/o/r/docs/guides/index`, not `/o/r/docs/guides`,
 *   so a file `guides.md` and a folder `guides/` never share a URL. Links to a folder resolve
 *   to the folder's index document in `links.ts`.
 * - Case is kept. Each segment is percent-encoded with `encodeURIComponent`.
 * - The extension is removed case-insensitively (the sync accepts `.MD`), so `a.md` and `a.mdx`
 *   in one folder share a URL; the sync keeps both rows and the page shows the first candidate
 *   from `docPathCandidates`.
 */

/** Stored documents have one of these extensions, matched case-insensitively. */
export const DOC_EXTENSION = /\.(?:md|mdx)$/i;

/** The literal URL segment between the repository and the document path. */
export const DOCS_ROUTE_SEGMENT = "docs";

function cleanFolder(docsFolder: string | null | undefined): string | null {
  if (typeof docsFolder !== "string" || docsFolder === "") return null;
  return docsFolder;
}

/** Path segments that are safe to put in a URL path: non-empty, not `.` or `..`. */
function plainSegments(segments: readonly string[]): boolean {
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * The document path below the docs folder with its extension removed, or `null` when
 * `docPath` is not a Markdown file under `docsFolder` (or has an odd segment).
 */
export function docRouteStem(
  docPath: string,
  docsFolder: string | null | undefined,
): string | null {
  const folder = cleanFolder(docsFolder);
  if (folder === null) return null;
  const prefix = `${folder}/`;
  if (!docPath.startsWith(prefix)) return null;
  const rest = docPath.slice(prefix.length);
  if (!DOC_EXTENSION.test(rest)) return null;
  const stem = rest.replace(DOC_EXTENSION, "");
  if (stem === "" || stem.endsWith("/")) return null;
  return plainSegments(stem.split("/")) ? stem : null;
}

/**
 * Root-relative URL of the in-app page for a document, or `null` when the document is not
 * under `docsFolder` (such a document has no page; callers fall back to GitHub).
 * `docPath` is repo-relative, as stored in `documents.path`.
 */
export function docUrl(
  owner: string,
  repo: string,
  docPath: string,
  docsFolder: string | null | undefined,
): string | null {
  const stem = docRouteStem(docPath, docsFolder);
  if (stem === null) return null;
  const tail = stem.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${DOCS_ROUTE_SEGMENT}/${tail}`;
}

/** The literal URL segment between the repository and an API spec path. */
export const API_REFERENCE_ROUTE_SEGMENT = "api-reference";

/**
 * Root-relative URL of an API reference page: `/<owner>/<repo>/api-reference/<spec path>`, where
 * `specPath` is the repo-relative path stored in `api_specs.path`. Case is kept and each segment
 * is percent-encoded. Returns `null` for an empty, `.` or `..` segment.
 */
export function apiReferenceUrl(owner: string, repo: string, specPath: string): string | null {
  const parts = specPath.split("/");
  if (!plainSegments(parts)) return null;
  const tail = parts.map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${API_REFERENCE_ROUTE_SEGMENT}/${tail}`;
}

/**
 * Inverse of `apiReferenceUrl` for a page: the already-decoded catch-all segments joined into the
 * stored spec path, or `null` when they are not a valid route (empty, `.`, `..`, a segment with
 * `/`, `\\` or a control character).
 */
export function apiSpecPathFromSegments(segments: readonly string[]): string | null {
  if (segments.length === 0 || !plainSegments(segments)) return null;
  if (segments.some((s) => /[/\\\u0000-\u001f\u007f]/.test(s))) return null;
  return segments.join("/");
}

/**
 * Root-relative URL of a repository space (`/<owner>/<repo>`, task 9.2). Each segment is
 * percent-encoded with `encodeURIComponent`, so odd characters in a stored name cannot change
 * the path.
 */
export function repoUrl(owner: string, repo: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Path prefix of the image proxy route (`src/app/api/asset/[owner]/[repo]/[...path]`). */
export const ASSET_ROUTE_PREFIX = "/api/asset";

/**
 * Root-relative URL of the image proxy for a repo-relative file path (task 7.5). Each segment is
 * percent-encoded with `encodeURIComponent`; the route decodes each exactly once. No query: the
 * proxy always serves the repository's default branch. Returns `null` when `path` has an empty,
 * `.` or `..` segment (such a URL would be normalized by the browser before it is sent).
 */
export function assetUrl(owner: string, repo: string, path: string): string | null {
  const segments = path.split("/");
  if (!plainSegments(segments)) return null;
  return `${ASSET_ROUTE_PREFIX}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Inverse of `docUrl` for a page: `segments` are the already-decoded catch-all route
 * segments after `/docs/`. Returns the repo-relative stored paths to try, in order, or an empty
 * list when the segments are not a valid document route (empty, `.`, `..`, or a segment
 * containing `/`). Case is exact. A file with an upper-case extension (`A.MD`) needs a
 * case-insensitive lookup on top of this list.
 */
export function docPathCandidates(
  docsFolder: string | null | undefined,
  segments: readonly string[],
): string[] {
  const folder = cleanFolder(docsFolder);
  if (folder === null || segments.length === 0) return [];
  if (!plainSegments(segments) || segments.some((s) => /[/\\\u0000-\u001f\u007f]/.test(s))) {
    return [];
  }
  const stem = `${folder}/${segments.join("/")}`;
  return [`${stem}.md`, `${stem}.mdx`];
}

/**
 * First URL segments the app owns, so `/<owner>/<repo>` must never be looked up for them (task
 * 9.3). Next.js already prefers a static route (`/search`, `/api/sync`, `/e2e/theme`) to the
 * dynamic `[owner]` segment, but a path below one that has no route of its own (`/search/x`,
 * `/api/nothing`) would otherwise be read as a repository of an owner called `search`. Such a
 * request is a plain 404 without a database query. Compared case-insensitively. The cost: a
 * GitHub account with one of these logins has no repository space; add names here when a later
 * task adds a top-level route. Names with a dot or a leading underscore (`favicon.ico`, `_next`)
 * are not valid GitHub logins and are rejected by the owner check anyway; they are listed to make
 * the intent explicit.
 */
export const RESERVED_OWNERS: ReadonlySet<string> = new Set([
  "-",
  "api",
  "e2e",
  "search",
  "status",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "manifest.webmanifest",
]);

export function isReservedOwner(owner: string): boolean {
  return RESERVED_OWNERS.has(owner.toLowerCase());
}

/** First URL segments that are pages of the app itself, never a repository owner (public access). */
const APP_SEGMENTS: ReadonlySet<string> = new Set(["admin", "account", "login", "ask"]);

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Whether a request without a session may be one for public content (public access design
 * decision 3). The proxy has no database, so it cannot tell whether anything is public; it lets
 * these paths through and the page or route decides. Only reads of the home page, the search and
 * Ask pages, a repository or a document, `GET /api/search`, `GET /api/asset/...` and
 * `POST /api/ask` qualify; admin, account, status, comments, tokens, sync, plugin and every other
 * path keep the cookie gate. `pathname` is the URL path without the query.
 */
export function mayBePublicPath(pathname: string, method: string): boolean {
  const verb = method.toUpperCase();
  const read = READ_METHODS.has(verb);
  if (pathname === "/") return read;
  if (pathname === "/search" || pathname === "/ask") return read;
  if (pathname === "/api/search") return read;
  if (pathname === "/api/ask") return verb === "POST";
  if (pathname === "/api/asset" || pathname.startsWith("/api/asset/")) return read;
  if (!read || !pathname.startsWith("/")) return false;
  // A repository or a document: `/<owner>/<repo>` and below, owner not an app segment.
  const segments = pathname.slice(1).split("/");
  const owner = segments[0] ?? "";
  if (segments.length < 2 || segments[1] === "") return false;
  return !isReservedOwner(owner) && !APP_SEGMENTS.has(owner.toLowerCase());
}
