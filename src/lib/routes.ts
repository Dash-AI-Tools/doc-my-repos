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
