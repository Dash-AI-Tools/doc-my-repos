import { z } from "zod";

import { logger, type Logger } from "../log";

/**
 * A small GitHub REST client for the sync engine, built on an injected `fetch`.
 *
 * - Authentication is injected as `getToken`; the installation token provider (`app-auth.ts`)
 *   plugs in there. The token is read before every attempt, so a refreshed token is picked up by a
 *   retry. It lives only in the closure of `createGitHubClient`: it is not a property of the
 *   client, never put in an error, and never logged.
 * - A 401 is retried exactly once per request, asking `getToken` for a token other than the one
 *   GitHub just rejected (`rejectedToken`). That retry does not count against `maxAttempts`. A
 *   second 401 fails with `unauthorized`.
 * - A `GitHubError` thrown by `getToken` (such as `installation_unavailable`) reaches the caller
 *   unchanged; any other provider error becomes `unauthorized`, without its message.
 * - Rate limits: a 429, or a 403 with `retry-after` or `x-ratelimit-remaining: 0`, is waited out
 *   when the wait fits `maxWaitMs`, otherwise it fails at once with `rate_limited` and
 *   `retryAfterMs`, so the caller can record a retryable error. Any other 403 is `forbidden` and
 *   is not retried. 5xx and network errors back off exponentially with jitter. All retries share
 *   one bounded `maxAttempts`.
 * - The client never decides what a 404 means. It throws `not_found`; the removal rule lives in
 *   the sync engine.
 * - Errors carry a stable `kind`, the HTTP status and a fixed message. Response bodies, request
 *   headers and the original fetch error are never copied into them, because they can echo
 *   credentials.
 */

export type GitHubErrorKind =
  | "rate_limited"
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "server"
  | "network"
  | "aborted"
  /** Any other 4xx (bad request, gone, unprocessable). */
  | "client_error"
  /** A 2xx response that is not the expected shape, or a listing that cannot be completed. */
  | "invalid_response"
  /** An owner, repo, ref, sha or path that failed validation. Nothing was sent. */
  | "invalid_input"
  /** A file larger than the caller's `maxBytes` (`getFile`). Not retried. */
  | "too_large"
  /** The App installation is gone (uninstalled) or suspended. Stored content must be kept. */
  | "installation_unavailable"
  /** GitHub rejected the App's own credentials (App id or private key) when minting a token. */
  | "app_credentials"
  /** The configured private key is not a usable PEM RSA private key. Nothing was sent. */
  | "invalid_private_key";

const MESSAGES: Record<GitHubErrorKind, string> = {
  rate_limited: "github: rate limit exhausted",
  not_found: "github: not found",
  forbidden: "github: forbidden",
  unauthorized: "github: unauthorized",
  server: "github: server error",
  network: "github: network error",
  aborted: "github: request aborted",
  client_error: "github: request rejected",
  invalid_response: "github: unexpected response",
  invalid_input: "github: invalid request input",
  too_large: "github: file larger than the allowed size",
  installation_unavailable:
    "github: GitHub App installation unavailable (uninstalled or suspended)",
  app_credentials: "github: GitHub App credentials rejected (check the App id and private key)",
  invalid_private_key: "github: GitHub App private key is not a valid PEM RSA private key",
};

/** A fixed-message error. It never carries tokens, headers, or GitHub response bodies. */
export class GitHubError extends Error {
  override name = "GitHubError";
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;
  /** For `rate_limited`: milliseconds until a retry can succeed, when GitHub said so. */
  readonly retryAfterMs: number | undefined;

  constructor(kind: GitHubErrorKind, status?: number, retryAfterMs?: number) {
    super(MESSAGES[kind]);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** True for errors worth retrying later (as opposed to a permanent failure). */
export function isRetryableKind(kind: GitHubErrorKind): boolean {
  return kind === "rate_limited" || kind === "server" || kind === "network";
}

export interface GetTokenOptions {
  /**
   * A token GitHub just answered 401 to. The provider must not return it again; it discards it
   * if it is still cached and returns a fresh one (or one another caller already refreshed).
   */
  rejectedToken?: string;
}

export interface GitHubClientOptions {
  /** Returns a current token. Called before every attempt. */
  getToken: (options?: GetTokenOptions) => Promise<string>;
  fetch?: typeof fetch;
  /** Resolves after `ms`, or earlier when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  baseUrl?: string;
  userAgent?: string;
  /** Total attempts per request, first try included. Default 4. */
  maxAttempts?: number;
  /** Longest single wait. A rate-limit wait beyond it fails instead. Default 60000. */
  maxWaitMs?: number;
  /** First backoff for 5xx and network errors. Default 500. */
  baseBackoffMs?: number;
  /** Largest accepted response body. Default 20 MiB. */
  maxBodyBytes?: number;
  /** Most pages walked by a listing. Default 100. */
  maxPages?: number;
  /** Structured log for retries and rate-limit waits (no URL, header or token). Default `logger`. */
  log?: Logger;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ConditionalOptions extends CallOptions {
  /** Sent as `If-None-Match`. */
  etag?: string | null;
}

export type Conditional<T> =
  { notModified: true } | { notModified: false; data: T; etag: string | null };

export interface RepoInfo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  archived: boolean;
  /** GitHub's `internal` (and anything not clearly public) maps to `private`, failing closed. */
  visibility: "public" | "private";
  description: string | null;
  htmlUrl: string;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number | null;
}

export interface TreeInfo {
  sha: string;
  truncated: boolean;
  entries: TreeEntry[];
}

export interface BranchHead {
  commitSha: string;
  treeSha: string;
}

export interface GitHubClient {
  getRepo(
    owner: string,
    repo: string,
    options?: ConditionalOptions,
  ): Promise<Conditional<RepoInfo>>;
  /** Every repository the installation can access. Any failure throws; it is never a short list. */
  listInstallationRepositories(options?: CallOptions): Promise<RepoInfo[]>;
  getTree(
    owner: string,
    repo: string,
    treeSha: string,
    options?: ConditionalOptions & { recursive?: boolean },
  ): Promise<Conditional<TreeInfo>>;
  getBlob(
    owner: string,
    repo: string,
    blobSha: string,
    options?: CallOptions,
  ): Promise<{ bytes: Uint8Array }>;
  /**
   * Raw bytes of one file, such as CODEOWNERS or an image for the asset proxy. With `maxBytes`, a
   * larger file (by `content-length` or by the bytes actually read, which stop at the limit)
   * throws `too_large` instead of `invalid_response`.
   */
  getFile(
    owner: string,
    repo: string,
    path: string,
    options?: ConditionalOptions & { ref?: string; maxBytes?: number },
  ): Promise<Conditional<Uint8Array>>;
  getBranchHead(
    owner: string,
    repo: string,
    branch: string,
    options?: ConditionalOptions,
  ): Promise<Conditional<BranchHead>>;
}

const API_VERSION = "2022-11-28";
/// Added to a wait derived from GitHub's reset time, which is in whole seconds.
const RESET_MARGIN_MS = 1000;
const PER_PAGE = 100;

// ---------------------------------------------------------------------------------------------
// Input validation

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function invalid(): never {
  throw new GitHubError("invalid_input");
}

/** A GitHub account (user or organization) login, as this client accepts it. */
export function isValidOwner(owner: unknown): owner is string {
  return typeof owner === "string" && OWNER_RE.test(owner);
}

/** A GitHub repository name, as this client accepts it. */
export function isValidRepoName(repo: unknown): repo is string {
  return typeof repo === "string" && REPO_RE.test(repo) && repo !== "." && repo !== "..";
}

function checkOwner(owner: string): string {
  if (!isValidOwner(owner)) invalid();
  return owner;
}

function checkRepo(repo: string): string {
  if (!isValidRepoName(repo)) invalid();
  return repo;
}

function checkSha(sha: string): string {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) invalid();
  return sha;
}

/** Encodes a slash-separated path one segment at a time; rejects traversal and control characters. */
function encodePath(path: string, extraForbidden: RegExp | null): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) invalid();
  if (CONTROL_RE.test(path) || path.includes("\\")) invalid();
  if (extraForbidden?.test(path)) invalid();
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") invalid();
    if (segment.includes("..") && extraForbidden) invalid();
  }
  return segments.map(encodeURIComponent).join("/");
}

function encodeFilePath(path: string): string {
  return encodePath(path, null);
}

/** Branch names: git ref rules, so also no `..`, spaces or `~^:?*[` characters. */
function encodeBranch(branch: string): string {
  if (typeof branch === "string" && branch.length > 255) invalid();
  return encodePath(branch, /[\s~^:?*[]/);
}

function checkRef(ref: string): string {
  encodeBranch(ref);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Response schemas

const repoSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  default_branch: z.string().min(1).nullish(),
  archived: z.boolean().optional(),
  private: z.boolean().optional(),
  visibility: z.string().optional(),
  description: z.string().nullish(),
  html_url: z.string().min(1),
});

const listSchema = z.object({
  total_count: z.number().int().nonnegative().optional(),
  repositories: z.array(repoSchema),
});

const treeSchema = z.object({
  sha: z.string().min(1),
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

const blobSchema = z.object({
  content: z.string(),
  encoding: z.string(),
  size: z.number().int().nonnegative().optional(),
});

const branchSchema = z.object({
  commit: z.object({
    sha: z.string().min(1),
    commit: z.object({ tree: z.object({ sha: z.string().min(1) }) }),
  }),
});

function toRepoInfo(raw: z.infer<typeof repoSchema>): RepoInfo {
  const isPublic =
    raw.visibility !== undefined ? raw.visibility === "public" : raw.private === false;
  return {
    id: raw.id,
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    // A repo with no default branch is empty; the sync treats "" as nothing to read.
    defaultBranch: raw.default_branch ?? "",
    archived: raw.archived === true,
    visibility: isPublic ? "public" : "private",
    description: raw.description ?? null,
    htmlUrl: raw.html_url,
  };
}

/**
 * Decodes GitHub's base64 (which wraps lines with newlines). Returns null for anything that is not
 * well-formed base64, instead of silently producing garbage the way `Buffer.from` would.
 */
export function decodeBase64Strict(input: string): Uint8Array | null {
  const compact = input.replace(/[\r\n]/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  return new Uint8Array(Buffer.from(compact, "base64"));
}

// ---------------------------------------------------------------------------------------------
// Transport

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Milliseconds GitHub asks us to wait, from `retry-after` or the reset time, or null. */
export function rateLimitWaitMs(headers: Headers, now: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000 + RESET_MARGIN_MS;
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now) + RESET_MARGIN_MS;
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(0, reset * 1000 - now) + RESET_MARGIN_MS;
    }
  }
  return null;
}

export function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return (
    status === 403 &&
    (headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") === "0")
  );
}

interface RequestSpec {
  path: string;
  query?: string;
  accept: string;
  etag?: string | null;
  signal?: AbortSignal;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const { getToken } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const userAgent = options.userAgent ?? "docmyrepos";
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  const maxBodyBytes = options.maxBodyBytes ?? 20 * 1024 * 1024;
  const maxPages = options.maxPages ?? 100;
  const log = options.log ?? logger;

  const backoffMs = (attempt: number) =>
    Math.min(maxWaitMs, baseBackoffMs * 2 ** attempt) * (0.5 + 0.5 * random());

  /** Waits `ms`; throws `aborted` when the signal fired before or during the wait. */
  async function pause(ms: number, signal?: AbortSignal): Promise<void> {
    await sleep(ms, signal);
    if (signal?.aborted) throw new GitHubError("aborted");
  }

  /** Runs one request with retries. Resolves with a 2xx or 304 response, otherwise throws. */
  async function send(spec: RequestSpec): Promise<Response> {
    const { signal } = spec;
    const url = `${baseUrl}${spec.path}${spec.query ? `?${spec.query}` : ""}`;

    let rejectedToken: string | undefined;
    let retriedUnauthorized = false;

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new GitHubError("aborted");
      const last = attempt >= maxAttempts - 1;

      let token: string;
      try {
        token = await getToken(rejectedToken === undefined ? undefined : { rejectedToken });
      } catch (error) {
        // Our own errors carry fixed messages only. Anything else is dropped: it may mention
        // credentials.
        if (error instanceof GitHubError) throw error;
        throw new GitHubError("unauthorized");
      }
      rejectedToken = undefined;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: spec.accept,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": userAgent,
      };
      if (spec.etag) headers["If-None-Match"] = spec.etag;

      let res: Response;
      try {
        res = await doFetch(url, { method: "GET", headers, signal });
      } catch {
        if (signal?.aborted) throw new GitHubError("aborted");
        if (last) throw new GitHubError("network");
        const waitMs = backoffMs(attempt);
        log.debug("github.retry", {
          reason: "network",
          attempt: attempt + 1,
          waitMs: Math.round(waitMs),
        });
        await pause(waitMs, signal);
        continue;
      }

      const { status } = res;
      if ((status >= 200 && status < 300) || status === 304) return res;

      // Not returning the response: free the connection without reading the body.
      void res.body?.cancel().catch(() => undefined);

      if (isRateLimited(status, res.headers)) {
        const asked = rateLimitWaitMs(res.headers, now());
        const wait = asked ?? backoffMs(attempt);
        if ((asked !== null && asked > maxWaitMs) || last) {
          log.warn("github.rate_limit.exceeded", {
            status,
            retryAfterMs: asked === null ? null : Math.round(asked),
          });
          throw new GitHubError("rate_limited", status, asked ?? undefined);
        }
        log.warn("github.rate_limit.wait", {
          status,
          retryAfterMs: Math.round(wait),
          attempt: attempt + 1,
        });
        await pause(wait, signal);
        continue;
      }
      if (status === 401) {
        if (retriedUnauthorized) throw new GitHubError("unauthorized", status);
        // Expired or revoked token: retry once at once with a fresh one, outside `maxAttempts`.
        retriedUnauthorized = true;
        rejectedToken = token;
        log.info("github.token.rejected", { status, action: "refresh_and_retry" });
        attempt--;
        continue;
      }
      if (status === 403) throw new GitHubError("forbidden", status);
      if (status === 404) throw new GitHubError("not_found", status);
      if (status >= 500) {
        if (last) throw new GitHubError("server", status);
        const waitMs = backoffMs(attempt);
        log.debug("github.retry", {
          reason: "server",
          status,
          attempt: attempt + 1,
          waitMs: Math.round(waitMs),
        });
        await pause(waitMs, signal);
        continue;
      }
      throw new GitHubError("client_error", status);
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    const bytes = await readBytes(res);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new GitHubError("invalid_response", res.status);
    }
  }

  /**
   * Reads at most `limit` bytes, cancelling the stream as soon as it is exceeded, so a large body
   * without `content-length` is never buffered whole. Over the limit throws `too_large`.
   */
  async function readBytesWithin(res: Response, limit: number): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      void res.body?.cancel().catch(() => undefined);
      throw new GitHubError("too_large", res.status);
    }
    if (res.body === null) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          void reader.cancel().catch(() => undefined);
          throw new GitHubError("too_large", res.status);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError("network");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async function readBytes(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      void res.body?.cancel().catch(() => undefined);
      throw new GitHubError("invalid_response", res.status);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new GitHubError("network");
    }
    if (bytes.length > maxBodyBytes) throw new GitHubError("invalid_response", res.status);
    return bytes;
  }

  function parse<S extends z.ZodType>(schema: S, value: unknown, status: number): z.infer<S> {
    const result = schema.safeParse(value);
    if (!result.success) throw new GitHubError("invalid_response", status);
    return result.data;
  }

  /** GET JSON with optional conditional request; `map` turns the validated body into the result. */
  async function getJson<S extends z.ZodType, T>(
    spec: Omit<RequestSpec, "accept">,
    schema: S,
    map: (data: z.infer<S>) => T,
  ): Promise<Conditional<T>> {
    const res = await send({ ...spec, accept: "application/vnd.github+json" });
    if (res.status === 304) return { notModified: true };
    const data = map(parse(schema, await readJson(res), res.status));
    return { notModified: false, data, etag: res.headers.get("etag") };
  }

  const repoPath = (owner: string, repo: string) =>
    `/repos/${encodeURIComponent(checkOwner(owner))}/${encodeURIComponent(checkRepo(repo))}`;

  function unwrap<T>(result: Conditional<T>, status: number): T {
    if (result.notModified) throw new GitHubError("invalid_response", status);
    return result.data;
  }

  return {
    async getRepo(owner, repo, opts = {}) {
      return getJson(
        { path: repoPath(owner, repo), etag: opts.etag, signal: opts.signal },
        repoSchema,
        toRepoInfo,
      );
    },

    async listInstallationRepositories(opts = {}) {
      const repos: RepoInfo[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const result = await getJson(
          {
            path: "/installation/repositories",
            query: `per_page=${PER_PAGE}&page=${page}`,
            signal: opts.signal,
          },
          listSchema,
          (data) => data,
        );
        const data = unwrap(result, 304);
        for (const raw of data.repositories) repos.push(toRepoInfo(raw));
        if (data.repositories.length < PER_PAGE) return repos;
        if (data.total_count !== undefined && repos.length >= data.total_count) return repos;
      }
      // Never hand back a partial listing as if it were complete.
      throw new GitHubError("invalid_response");
    },

    async getTree(owner, repo, treeSha, opts = {}) {
      return getJson(
        {
          path: `${repoPath(owner, repo)}/git/trees/${checkSha(treeSha)}`,
          query: opts.recursive === false ? undefined : "recursive=1",
          etag: opts.etag,
          signal: opts.signal,
        },
        treeSchema,
        (data): TreeInfo => ({
          sha: data.sha,
          truncated: data.truncated,
          entries: data.tree.map((e) => ({
            path: e.path,
            mode: e.mode,
            type: e.type,
            sha: e.sha,
            size: e.size ?? null,
          })),
        }),
      );
    },

    async getBlob(owner, repo, blobSha, opts = {}) {
      const result = await getJson(
        { path: `${repoPath(owner, repo)}/git/blobs/${checkSha(blobSha)}`, signal: opts.signal },
        blobSchema,
        (data) => data,
      );
      const blob = unwrap(result, 304);
      const bytes = blob.encoding === "base64" ? decodeBase64Strict(blob.content) : null;
      if (bytes === null || (blob.size !== undefined && blob.size !== bytes.length)) {
        throw new GitHubError("invalid_response");
      }
      return { bytes };
    },

    async getFile(owner, repo, path, opts = {}) {
      const target = `${repoPath(owner, repo)}/contents/${encodeFilePath(path)}`;
      const query =
        opts.ref === undefined ? undefined : `ref=${encodeURIComponent(checkRef(opts.ref))}`;
      const res = await send({
        path: target,
        query,
        accept: "application/vnd.github.raw+json",
        etag: opts.etag,
        signal: opts.signal,
      });
      if (res.status === 304) return { notModified: true };
      const limit = opts.maxBytes;
      const data =
        limit === undefined
          ? await readBytes(res)
          : await readBytesWithin(res, Math.max(0, Math.min(limit, maxBodyBytes)));
      return { notModified: false, data, etag: res.headers.get("etag") };
    },

    async getBranchHead(owner, repo, branch, opts = {}) {
      return getJson(
        {
          path: `${repoPath(owner, repo)}/branches/${encodeBranch(branch)}`,
          etag: opts.etag,
          signal: opts.signal,
        },
        branchSchema,
        (data): BranchHead => ({
          commitSha: data.commit.sha,
          treeSha: data.commit.commit.tree.sha,
        }),
      );
    },
  };
}
