import { inspect } from "node:util";

import { createAppAuth } from "@octokit/auth-app";
import { request as octokitRequest } from "@octokit/request";
import githubAppJwt from "universal-github-app-jwt";

import { pemProblem } from "../config/env";
import type { Secret } from "../config/secret";
import {
  GitHubError,
  isRateLimited,
  rateLimitWaitMs,
  type GetTokenOptions,
  type GitHubErrorKind,
} from "./client";

/**
 * GitHub App installation token provider. Its `getToken` plugs into `createGitHubClient`.
 *
 * - Minting goes through `@octokit/auth-app` (`POST /app/installations/{id}/access_tokens`) with
 *   an injected `fetch`. The library's token cache is replaced by a no-op cache and every call
 *   passes `refresh: true`, so caching, expiry and refresh are ours and follow the injected clock.
 * - The JWT is signed by `universal-github-app-jwt` (the library auth-app uses) through auth-app's
 *   `createJwt` hook, so the private key is revealed only at signing time and the injected clock
 *   sets `iat`. That library backdates `iat` by 30 s for clock drift and sets `exp` 10 minutes
 *   after the backdated `iat`, inside GitHub's 10 minute maximum.
 * - No `permissions`, `repositoryIds` or `repositoryNames` are sent: the token gets exactly the
 *   App's own (read-only) permissions on the installation's repositories, never more.
 * - Cache: one token, in memory only. A token's lifetime is measured against GitHub's `Date`
 *   header when present (so local clock skew does not shorten or stretch it) and capped at one
 *   hour. It is refreshed `refreshMarginMs` (default 5 min) before expiry; a token that lives no
 *   longer than the margin is refreshed at half its life. A token is reused only while the clock
 *   is between its receipt time and its refresh time; a clock that went backwards past the receipt
 *   time means elapsed time is unknown, so the token is replaced.
 * - Concurrent callers share one in-flight mint. A failed mint is remembered for
 *   `failureCooldownMs` (default 5 s) so callers fail fast instead of hammering GitHub; after
 *   that the next call tries again. Network errors and 5xx are retried inside one mint with
 *   bounded exponential backoff.
 * - When a refresh fails while the cached token has not yet expired, the cached token keeps
 *   being served until its expiry. A request that lands on GitHub just after expiry gets a 401,
 *   which the client turns into one retry with a fresh token.
 * - Errors are `GitHubError`s with fixed messages: `installation_unavailable` (404: uninstalled;
 *   403 whose message says suspended), `app_credentials` (401: bad App id, key or JWT),
 *   `invalid_private_key` (bad PEM, thrown at creation), `forbidden`, `rate_limited`, `server`,
 *   `network`, `client_error`, `invalid_response`. They never carry the key, the JWT, the token,
 *   headers, GitHub's response body or the original error.
 * - Known limit: `@octokit/auth-app` shares in-flight mints per installation id across all
 *   providers in the process. One provider per installation (the MVP has one) is unaffected.
 */

export interface InstallationTokenProviderOptions {
  appId: number;
  installationId: number;
  /** PEM text (PKCS#1 `RSA PRIVATE KEY` or PKCS#8 `PRIVATE KEY`), as validated by `parseEnv`. */
  privateKey: Secret<string>;
  fetch?: typeof fetch;
  /** Wall clock in milliseconds. Used for JWT `iat` and for token expiry. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseUrl?: string;
  userAgent?: string;
  /** Refresh this long before expiry. Default 5 minutes. */
  refreshMarginMs?: number;
  /** How long a failed mint is reported without asking GitHub again. Default 5 seconds. */
  failureCooldownMs?: number;
  /** Attempts per mint for network errors and 5xx, first try included. Default 3. */
  maxAttempts?: number;
  /** First backoff between mint attempts. Default 500 ms. */
  baseBackoffMs?: number;
  /** Timeout for one token request. Default 30 seconds. */
  requestTimeoutMs?: number;
}

export interface InstallationTokenProvider {
  /**
   * Returns a valid installation token, minting one when none is cached or it is due for refresh.
   * With `rejectedToken`, that token is discarded if it is still cached and a different one is
   * returned.
   */
  getToken(options?: GetTokenOptions): Promise<string>;
  /** Drops the cached token; the next `getToken` mints a new one. */
  invalidate(): void;
}

interface CachedToken {
  token: string;
  /** Local clock when the token arrived. */
  receivedAt: number;
  refreshAt: number;
  expiresAt: number;
}

interface Failure {
  error: GitHubError;
  at: number;
  until: number;
}

const API_VERSION = "2022-11-28";
/// GitHub installation tokens live one hour; never trust a longer lifetime.
const MAX_LIFETIME_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;
/// A token is sent in an HTTP header: printable ASCII only, so it cannot inject headers.
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/;
const REDACTED = "[redacted]";

const SILENT_LOG = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** auth-app's cache is disabled: `get` misses, `set` drops. */
const NO_CACHE = { get: () => "", set: () => undefined };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function toHeaders(raw: unknown): Headers {
  const headers = new Headers();
  if (typeof raw !== "object" || raw === null) return headers;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    try {
      headers.set(name, String(value));
    } catch {
      // A header GitHub would never send; ignore it.
    }
  }
  return headers;
}

/** True when GitHub's error body says the installation is suspended. The body is not kept. */
function saysSuspended(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("message" in data)) return false;
  const { message } = data as { message: unknown };
  return typeof message === "string" && /suspended/i.test(message);
}

/** Makes `target` print as `[redacted]` when inspected, stringified or serialized. */
function redactWhenLogged<T extends object>(target: T): T {
  const hide = () => REDACTED;
  for (const key of [inspect.custom, "toJSON", "toString"]) {
    Object.defineProperty(target, key, { value: hide, enumerable: false, configurable: false });
  }
  return target;
}

export function createInstallationTokenProvider(
  options: InstallationTokenProviderOptions,
): InstallationTokenProvider {
  const { appId, installationId, privateKey } = options;
  if (!isPositiveId(appId) || !isPositiveId(installationId)) {
    throw new GitHubError("invalid_input");
  }
  // Fail fast on a key that cannot sign. The check never reports any part of the key.
  const pem: unknown = privateKey.reveal();
  if (typeof pem !== "string" || pemProblem(pem.trim()) !== null) {
    throw new GitHubError("invalid_private_key");
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const userAgent = options.userAgent ?? "docmyrepos";
  const refreshMarginMs = Math.max(0, options.refreshMarginMs ?? 5 * 60 * 1000);
  const failureCooldownMs = Math.max(0, options.failureCooldownMs ?? 5000);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseBackoffMs = Math.max(0, options.baseBackoffMs ?? 500);
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);

  // `Date` header of the last token response. Mints are single-flight, so it belongs to the
  // response being processed.
  let lastServerDate: string | null = null;

  const trackedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    // The token endpoint never redirects; refuse to carry the JWT anywhere else.
    const res = await doFetch(input, { ...init, signal, redirect: "error" });
    lastServerDate = res.headers.get("date");
    return res;
  };

  const request = octokitRequest.defaults({
    baseUrl,
    headers: { "user-agent": userAgent, "x-github-api-version": API_VERSION },
    request: { fetch: trackedFetch, log: SILENT_LOG },
  });

  const auth = createAppAuth({
    appId,
    installationId,
    request,
    cache: NO_CACHE,
    log: SILENT_LOG,
    // Signs the App JWT. The key is revealed here only; errors are replaced by a fixed one.
    createJwt: async (_appId: string | number, timeDifference?: number) => {
      try {
        const { token, expiration } = await githubAppJwt({
          id: appId,
          privateKey: privateKey.reveal(),
          now: Math.floor(now() / 1000) + (timeDifference ?? 0),
        });
        return { jwt: token, expiresAt: new Date(expiration * 1000).toISOString() };
      } catch {
        throw new GitHubError("invalid_private_key");
      }
    },
  });

  /** Maps any mint failure to a fixed-message error. The original error is dropped. */
  function classify(error: unknown): GitHubError {
    if (error instanceof GitHubError) return error;
    if (typeof error !== "object" || error === null) return new GitHubError("invalid_response");
    const e = error as { name?: unknown; status?: unknown; response?: unknown };
    if (e.name === "AbortError" || e.name === "TimeoutError") return new GitHubError("network");
    if (typeof e.status !== "number") return new GitHubError("invalid_response");
    const status = e.status;
    // @octokit/request reports a fetch failure as status 500 without a response.
    if (typeof e.response !== "object" || e.response === null) return new GitHubError("network");
    const response = e.response as { headers?: unknown; data?: unknown };
    const headers = toHeaders(response.headers);
    if (isRateLimited(status, headers)) {
      return new GitHubError("rate_limited", status, rateLimitWaitMs(headers, now()) ?? undefined);
    }
    let kind: GitHubErrorKind;
    if (status === 404) kind = "installation_unavailable";
    else if (status === 403)
      kind = saysSuspended(response.data) ? "installation_unavailable" : "forbidden";
    else if (status === 401) kind = "app_credentials";
    else if (status >= 500) kind = "server";
    else kind = "client_error";
    return new GitHubError(kind, status);
  }

  async function mintOnce(): Promise<CachedToken> {
    lastServerDate = null;
    let token: unknown;
    let expiresAtText: unknown;
    try {
      const result = await auth({ type: "installation", refresh: true });
      token = result.token;
      expiresAtText = result.expiresAt;
    } catch (error) {
      throw classify(error);
    }
    const receivedAt = now();
    if (typeof token !== "string" || !TOKEN_RE.test(token) || typeof expiresAtText !== "string") {
      throw new GitHubError("invalid_response");
    }
    const serverDate = lastServerDate === null ? Number.NaN : Date.parse(lastServerDate);
    const serverNow = Number.isFinite(serverDate) ? serverDate : receivedAt;
    const lifetime = Math.min(MAX_LIFETIME_MS, Date.parse(expiresAtText) - serverNow);
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new GitHubError("invalid_response");
    const expiresAt = receivedAt + lifetime;
    const refreshAt =
      lifetime > refreshMarginMs ? expiresAt - refreshMarginMs : receivedAt + lifetime / 2;
    return { token, receivedAt, refreshAt, expiresAt };
  }

  async function mintWithRetries(): Promise<CachedToken> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await mintOnce();
      } catch (error) {
        const err = classify(error);
        const transient = err.kind === "network" || err.kind === "server";
        if (!transient || attempt >= maxAttempts - 1) throw err;
        const ceiling = Math.min(MAX_BACKOFF_MS, baseBackoffMs * 2 ** attempt);
        await sleep(ceiling * (0.5 + 0.5 * random()));
      }
    }
  }

  let cached: CachedToken | null = null;
  let inflight: Promise<CachedToken> | null = null;
  let failure: Failure | null = null;

  /** Starts a mint, or joins the one in flight. */
  function mint(): Promise<CachedToken> {
    if (inflight !== null) return inflight;
    const run = (async () => {
      try {
        const fresh = await mintWithRetries();
        cached = fresh;
        failure = null;
        return fresh;
      } catch (error) {
        const err = classify(error);
        const at = now();
        failure = { error: err, at, until: at + failureCooldownMs };
        throw err;
      } finally {
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  }

  const usable = (c: CachedToken | null, t: number): c is CachedToken =>
    c !== null && t >= c.receivedAt && t < c.expiresAt;

  async function getToken(opts?: GetTokenOptions): Promise<string> {
    const rejected = opts?.rejectedToken;
    if (rejected !== undefined && cached !== null && cached.token === rejected) cached = null;

    const t = now();
    const current = cached;
    if (usable(current, t) && t < current.refreshAt) return current.token;
    const fallback = usable(current, t) ? current : null;

    if (inflight === null && failure !== null && failure.at <= t && t < failure.until) {
      if (fallback !== null) return fallback.token;
      const { kind, status, retryAfterMs } = failure.error;
      throw new GitHubError(kind, status, retryAfterMs);
    }

    try {
      return (await mint()).token;
    } catch (error) {
      // Refresh failed: keep serving the cached token until it really expires.
      if (fallback !== null && cached === fallback && usable(fallback, now())) {
        return fallback.token;
      }
      throw error;
    }
  }

  function invalidate(): void {
    cached = null;
  }

  return Object.freeze(redactWhenLogged({ getToken, invalidate }));
}
