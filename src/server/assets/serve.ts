import { createHash } from "node:crypto";

import { GitHubError, type GitHubClient } from "../github/client";
import type { AssetRepo } from "../queries/assets";
import { assetCacheKey, type AssetCache, type AssetOutcome } from "./cache";
import { bytesMatchType, CONTENT_TYPES, imageTypeForPath } from "./image-types";
import { parseAssetTarget, rawAssetSegments } from "./path";

/**
 * The image proxy, `GET|HEAD /api/asset/{owner}/{repo}/{path}` (task 7.5). The only place that
 * reads GitHub while serving a request (CLAUDE.md architecture rules). No Next.js imports: the
 * route file (`src/app/api/asset/[owner]/[repo]/[...path]/route.ts`) only calls
 * `handleAssetRequest`, and `service.ts` binds the real runtime.
 *
 * Order of checks. Everything before step 4 depends on the URL alone, so a refusal there says
 * nothing about which repositories exist:
 *
 *  1. Method: GET or HEAD, else 405 with `Allow: GET, HEAD`.
 *  2. Path (`path.ts`): owner and name valid GitHub names; each file path segment
 *     percent-decoded exactly once from the request URL, never normalized; no empty, dot-only,
 *     `.git`, slash- or backslash-holding, control, bidi or still-encoded segment; at most 1024
 *     characters and 64 segments. Else 400.
 *  3. Extension on the image allow-list (`image-types.ts`), else 415. No database or GitHub
 *     access happens for any other file.
 *  4. The repository must be synced and visible through the shared visibility filter
 *     (`findAssetRepo`, case-insensitive owner/name), still selected by the current config, and
 *     not empty. Else 404, the same answer as a missing file.
 *  5. Cache (`cache.ts`), else GitHub: `getFile` on the default branch with the installation
 *     token, at most `maxBytes` (10 MiB, else 413), within `timeoutMs` (15 s, else 504), aborted
 *     when the client goes away. Not found or forbidden upstream: 404. Rate limited: 503 with
 *     `Retry-After`. Anything else: 502.
 *  6. The bytes must be an image of the type the extension claims (`bytesMatchType`), else 415.
 *
 * Responses. `Content-Type` is set from the verified type, never taken from GitHub. Every
 * response, errors included, carries `X-Content-Type-Options: nosniff`,
 * `Content-Security-Policy: default-src 'none'; sandbox` (SVG also `style-src 'unsafe-inline'`),
 * `Cross-Origin-Resource-Policy: same-origin` and `Referrer-Policy: no-referrer`. Images get a
 * strong `ETag` (SHA-256 of the bytes) and answer `If-None-Match` with 304. Cache headers follow
 * the stored visibility: `public, max-age=300, stale-while-revalidate=600` for public
 * repositories, `private, max-age=300` for private ones, so no shared cache ever stores a private
 * image. No `Vary`: the bytes depend on the URL alone. Errors are `no-store` with a fixed
 * plain-text body.
 *
 * Credentials. The installation token stays inside the GitHub client: it is never in a response,
 * a header, an error or a log line. Upstream response bodies and headers are never forwarded,
 * and no request header is sent upstream. Logs are fixed text plus a `GitHubError` kind; request
 * paths and names are not logged.
 */

/** Largest image served. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** Browser cache lifetime of an image, in seconds. Same as the server cache TTL. */
export const ASSET_MAX_AGE_SECONDS = 300;

/** Upper bound on one GitHub fetch, retries included. */
export const ASSET_TIMEOUT_MS = 15_000;

/** `Retry-After` when GitHub rate-limits without saying for how long. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export const ALLOWED_METHODS = "GET, HEAD";

export interface AssetDeps {
  /** The repository through the shared visibility filter, or null. */
  findRepo(owner: string, name: string): Promise<AssetRepo | null>;
  /** Whether the current config still selects this repository name. */
  isConfigured(name: string): boolean;
  github: Pick<GitHubClient, "getFile">;
  cache?: AssetCache | null;
}

export interface AssetRequestLike {
  readonly method: string;
  readonly headers: Headers;
  readonly signal?: AbortSignal;
}

export interface AssetResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** Null for HEAD and 304. */
  readonly body: Uint8Array<ArrayBuffer> | string | null;
}

export interface ServeAssetOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Operator log; only fixed text is passed. Default `console.error`. */
  log?: (message: string) => void;
}

const BASE_CSP = "default-src 'none'; sandbox";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function securityHeaders(csp = BASE_CSP): Record<string, string> {
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  };
}

const ERROR_TEXT: Readonly<Record<number, string>> = {
  400: "Invalid asset path.",
  404: "Not found.",
  405: "Method not allowed.",
  413: "Image too large.",
  415: "Not a supported image.",
  500: "The asset service is not available.",
  502: "The image could not be fetched.",
  503: "The image is temporarily unavailable. Try again later.",
  504: "Fetching the image timed out.",
};

function errorResponse(
  status: number,
  method: string,
  extra: Record<string, string> = {},
): AssetResponse {
  const text = ERROR_TEXT[status] ?? "Error.";
  return {
    status,
    headers: {
      ...securityHeaders(),
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(text)),
      ...extra,
    },
    body: method === "HEAD" ? null : text,
  };
}

/** Strong ETag of the bytes: the first 128 bits of their SHA-256, hex, quoted. */
export function assetEtag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
}

/** `If-None-Match` matching (weak comparison, as RFC 9110 requires for this header). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || bare(t) === bare(etag));
}

function cacheControl(visibility: AssetRepo["visibility"]): string {
  return visibility === "public"
    ? `public, max-age=${ASSET_MAX_AGE_SECONDS}, stale-while-revalidate=${ASSET_MAX_AGE_SECONDS * 2}`
    : `private, max-age=${ASSET_MAX_AGE_SECONDS}`;
}

function imageResponse(
  method: string,
  ifNoneMatch: string | null,
  outcome: Extract<AssetOutcome, { kind: "image" }>,
  repo: AssetRepo,
): AssetResponse {
  const common = {
    ...securityHeaders(outcome.type === "svg" ? SVG_CSP : BASE_CSP),
    etag: outcome.etag,
    "cache-control": cacheControl(repo.visibility),
  };
  if (etagMatches(ifNoneMatch, outcome.etag)) {
    return { status: 304, headers: common, body: null };
  }
  return {
    status: 200,
    headers: {
      ...common,
      "content-type": CONTENT_TYPES[outcome.type],
      "content-length": String(outcome.bytes.byteLength),
    },
    body: method === "HEAD" ? null : outcome.bytes,
  };
}

type FetchResult =
  | { kind: "outcome"; outcome: AssetOutcome; cacheable: boolean }
  | { kind: "failure"; status: 400 | 502 | 503 | 504; retryAfterSeconds?: number };

async function fetchAsset(
  request: AssetRequestLike,
  repo: AssetRepo,
  path: string,
  deps: AssetDeps,
  options: Required<Pick<ServeAssetOptions, "maxBytes" | "timeoutMs" | "log">>,
): Promise<FetchResult> {
  const claimed = imageTypeForPath(path);
  if (claimed === null) return { kind: "outcome", outcome: refused(415), cacheable: false };

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  let bytes: Uint8Array;
  try {
    const result = await deps.github.getFile(repo.owner, repo.name, path, {
      ref: repo.defaultBranch,
      maxBytes: options.maxBytes,
      signal,
    });
    if (result.notModified) {
      options.log("asset: unexpected not-modified answer from GitHub");
      return { kind: "failure", status: 502 };
    }
    bytes = result.data;
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      options.log("asset: unexpected failure while fetching an image");
      return { kind: "failure", status: 502 };
    }
    switch (error.kind) {
      case "not_found":
      case "forbidden":
        return { kind: "outcome", outcome: refused(404), cacheable: true };
      case "too_large":
        return { kind: "outcome", outcome: refused(413), cacheable: true };
      case "invalid_input":
        return { kind: "failure", status: 400 };
      case "rate_limited": {
        options.log("asset: GitHub rate limit reached");
        const seconds =
          error.retryAfterMs === undefined
            ? DEFAULT_RETRY_AFTER_SECONDS
            : Math.max(1, Math.ceil(error.retryAfterMs / 1000));
        return { kind: "failure", status: 503, retryAfterSeconds: seconds };
      }
      case "aborted":
        if (timeout.aborted) options.log("asset: GitHub request timed out");
        return { kind: "failure", status: 504 };
      default:
        options.log(`asset: GitHub request failed (${error.kind})`);
        return { kind: "failure", status: 502 };
    }
  }

  if (!bytesMatchType(bytes, claimed)) {
    return { kind: "outcome", outcome: refused(415), cacheable: true };
  }
  // A fresh ArrayBuffer-backed copy: never a view into a larger pooled buffer.
  const copy = new Uint8Array(bytes);
  return {
    kind: "outcome",
    outcome: { kind: "image", type: claimed, bytes: copy, etag: assetEtag(copy) },
    cacheable: true,
  };
}

function refused(status: 404 | 413 | 415): AssetOutcome {
  return { kind: "refused", status };
}

/**
 * Serves one asset request. `rawSegments` are the URL path segments after `/api/asset/`, still
 * percent-encoded (see `rawAssetSegments`). `getDeps` is called only once the URL is valid, so a
 * bad URL never builds the runtime. Never throws; never includes a credential in its result.
 */
export async function serveAsset(
  request: AssetRequestLike,
  rawSegments: readonly string[] | null,
  getDeps: () => AssetDeps,
  options: ServeAssetOptions = {},
): Promise<AssetResponse> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return errorResponse(405, method, { allow: ALLOWED_METHODS });
  }
  const target = rawSegments === null ? null : parseAssetTarget(rawSegments);
  if (target === null) return errorResponse(400, method);
  if (imageTypeForPath(target.path) === null) return errorResponse(415, method);

  const log = options.log ?? ((message: string) => console.error(message));
  let deps: AssetDeps;
  let repo: AssetRepo | null;
  try {
    deps = getDeps();
    repo = await deps.findRepo(target.owner, target.repo);
  } catch {
    // Config and database errors can name hosts or variables; log fixed text only.
    log("asset: repository lookup failed");
    return errorResponse(500, method);
  }
  if (repo === null || repo.defaultBranch === "" || !deps.isConfigured(repo.name)) {
    return errorResponse(404, method);
  }

  const key = assetCacheKey(repo.githubId, repo.defaultBranch, target.path);
  let outcome = deps.cache?.get(key);
  if (outcome === undefined) {
    const fetched = await fetchAsset(request, repo, target.path, deps, {
      maxBytes: options.maxBytes ?? MAX_ASSET_BYTES,
      timeoutMs: options.timeoutMs ?? ASSET_TIMEOUT_MS,
      log,
    });
    if (fetched.kind === "failure") {
      return errorResponse(
        fetched.status,
        method,
        fetched.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(fetched.retryAfterSeconds) },
      );
    }
    outcome = fetched.outcome;
    if (fetched.cacheable) deps.cache?.set(key, outcome);
  }

  if (outcome.kind === "refused") return errorResponse(outcome.status, method);
  return imageResponse(method, request.headers.get("if-none-match"), outcome, repo);
}

/** Turns an `AssetResponse` into a web `Response`. */
export function toResponse(result: AssetResponse): Response {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

/**
 * The route handler body: reads the raw path from `request.url` (Next.js params are not used, so
 * nothing is decoded twice), serves it, and never throws.
 */
export async function handleAssetRequest(
  request: Request,
  getDeps: () => AssetDeps,
  options: ServeAssetOptions = {},
): Promise<Response> {
  let segments: string[] | null;
  try {
    segments = rawAssetSegments(new URL(request.url).pathname);
  } catch {
    segments = null;
  }
  try {
    return toResponse(await serveAsset(request, segments, getDeps, options));
  } catch {
    (options.log ?? ((message: string) => console.error(message)))("asset: unexpected failure");
    return toResponse(errorResponse(500, request.method.toUpperCase()));
  }
}
