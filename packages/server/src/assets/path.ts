import { ASSET_ROUTE_PREFIX } from "@docmyrepos/core/internal/routes";
import { isValidOwner, isValidRepoName } from "../github/client";
import { CONTROL, LONE_SURROGATE } from "../markdown/links";

/**
 * Path rules for image assets (task 7.5), shared by the image rewriting plugin
 * (`packages/server/src/markdown/images.ts`), which never produces a URL these rules reject, and the proxy
 * (`serve.ts`), which applies them to every request. Pure: no I/O.
 */

/** Longest repo-relative asset path, in characters (also the GitHub client's path limit). */
export const MAX_ASSET_PATH_CHARS = 1024;

/** Most segments in an asset path. */
export const MAX_ASSET_SEGMENTS = 64;

/** Longest raw (percent-encoded) URL path accepted, before decoding. */
export const MAX_RAW_ASSET_PATH_CHARS = MAX_ASSET_PATH_CHARS * 3 + 512;

/** Bidirectional formatting characters: they make a path display differently from what it is. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;

/** A `%XX` escape left after decoding once: double encoding, never accepted. */
const ESCAPE = /%[0-9A-Fa-f]{2}/;

const ONLY_DOTS = /^\.+$/;
const SLASHES = /[/\\]/;

/**
 * Whether one already-decoded path segment may be part of an asset path:
 *  - not empty, and not made only of dots (`.`, `..`, `...`), also after Unicode NFKC
 *    normalization (fullwidth `．．`, the two-dot leader `‥`);
 *  - no `/` or `\`, also after NFKC (fullwidth solidus `／`);
 *  - no control character, line separator, lone surrogate or bidirectional control;
 *  - no `%XX` sequence (that would be a second level of encoding);
 *  - not `.git` (any case).
 * Hidden folders such as `.github/` are allowed: READMEs keep images there.
 */
export function isSafeAssetSegment(segment: string): boolean {
  if (segment === "" || ONLY_DOTS.test(segment) || SLASHES.test(segment)) return false;
  if (CONTROL.test(segment) || LONE_SURROGATE.test(segment) || BIDI.test(segment)) return false;
  if (ESCAPE.test(segment)) return false;
  if (segment.toLowerCase() === ".git") return false;
  const compat = segment.normalize("NFKC");
  return !ONLY_DOTS.test(compat) && !SLASHES.test(compat) && compat.toLowerCase() !== ".git";
}

/** Whether a repo-relative path (segments joined by `/`) is a valid asset path. */
export function isSafeAssetPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_ASSET_PATH_CHARS) return false;
  const segments = path.split("/");
  return segments.length <= MAX_ASSET_SEGMENTS && segments.every(isSafeAssetSegment);
}

export interface AssetTarget {
  /** Owner and repository name as requested (validated, any case). */
  readonly owner: string;
  readonly repo: string;
  /** Repo-relative path, segments decoded once and joined by `/`. */
  readonly path: string;
}

function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Decodes and validates the request path below `/api/asset/`: `rawSegments` are the
 * percent-encoded segments exactly as they appear in the request URL (`owner`, `repo`, then the
 * file path). Each is decoded exactly once. Returns null for anything that is not a valid
 * `owner/repo/path`, including empty segments (`a//b`, a trailing `/`), dot segments, encoded
 * slashes (`%2F`), double encoding (`%252e`) and an over-long path. No normalization happens:
 * the path that is fetched is exactly the segments that were sent.
 */
export function parseAssetTarget(rawSegments: readonly string[]): AssetTarget | null {
  if (rawSegments.length < 3 || rawSegments.length > MAX_ASSET_SEGMENTS + 2) return null;
  let rawLength = 0;
  for (const raw of rawSegments) rawLength += raw.length + 1;
  if (rawLength > MAX_RAW_ASSET_PATH_CHARS) return null;

  const decoded: string[] = [];
  for (const raw of rawSegments) {
    const segment = decodeOnce(raw);
    if (segment === null) return null;
    decoded.push(segment);
  }
  const [owner, repo, ...segments] = decoded;
  if (!isValidOwner(owner) || !isValidRepoName(repo)) return null;
  if (!segments.every(isSafeAssetSegment)) return null;
  const path = segments.join("/");
  if (path.length > MAX_ASSET_PATH_CHARS) return null;
  return { owner, repo, path };
}

/**
 * The raw segments after `/api/asset/` in a URL path (as `new URL(url).pathname` gives it), or
 * null when the path is not under the asset route.
 */
export function rawAssetSegments(pathname: string): string[] | null {
  const prefix = `${ASSET_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split("/");
}
