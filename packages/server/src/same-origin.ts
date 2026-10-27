/**
 * Same-origin guard for state-changing JSON requests (document-comments design decision 3).
 * Defense in depth on top of the `SameSite=Lax` session cookie; the comment writes use it and
 * other write routes can adopt it later. Pure: it reads headers only.
 *
 * A request passes when all of these hold:
 *  - `Sec-Fetch-Site`, when present, is not `cross-site`;
 *  - `Origin`, when present, names this server: scheme and host (with port) equal the request's.
 *    The request's own origin is taken from the request URL, the `Host` header and, behind a
 *    reverse proxy, `X-Forwarded-Host` / `X-Forwarded-Proto` (first value). `Origin: null` and
 *    anything unparsable are refused. An absent `Origin` is allowed: browsers always send it on
 *    cross-origin writes, so only non-browser clients (curl, scripts) omit it, and they are not
 *    a CSRF vector;
 *  - `Content-Type` is `application/json` (any parameters, any case). A cross-site form or
 *    `text/plain` post cannot send it without a CORS preflight, which this server never grants.
 *
 * Forwarded headers can be forged only by a client that is not a browser on another site (a
 * browser cannot set them on a cross-origin request without a preflight), so trusting them here
 * does not open a CSRF hole.
 */

export type SameOriginFailure = "cross_site" | "origin_mismatch" | "json_required";

export type SameOriginResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly code: SameOriginFailure;
      /** A fixed message, safe to show. */
      readonly error: string;
    };

const MESSAGES: Readonly<Record<SameOriginFailure, string>> = {
  cross_site: "Cross-site requests are not allowed",
  origin_mismatch: "Request origin does not match",
  json_required: "Content-Type must be application/json",
};

function fail(code: SameOriginFailure): SameOriginResult {
  return { ok: false, status: 403, code, error: MESSAGES[code] };
}

function firstValue(value: string | null): string | null {
  if (value === null) return null;
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "" ? null : first;
}

/** The hosts and schemes this server answers to, from the URL and the proxy headers. */
function ownOrigins(request: Request): { hosts: Set<string>; schemes: Set<string> } {
  const hosts = new Set<string>();
  const schemes = new Set<string>();
  try {
    const url = new URL(request.url);
    hosts.add(url.host.toLowerCase());
    schemes.add(url.protocol.slice(0, -1).toLowerCase());
  } catch {
    // an unparsable request URL contributes nothing
  }
  for (const host of [
    firstValue(request.headers.get("host")),
    firstValue(request.headers.get("x-forwarded-host")),
  ]) {
    if (host !== null) hosts.add(host);
  }
  const proto = firstValue(request.headers.get("x-forwarded-proto"));
  if (proto === "http" || proto === "https") schemes.add(proto);
  return { hosts, schemes };
}

function isJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const media = contentType.split(";")[0]?.trim().toLowerCase();
  return media === "application/json";
}

/**
 * The first two rules only: a cross-site fetch, or an `Origin` that is not this server's, fails.
 * Never throws and never reads the body. The MCP endpoint (mcp-agent-access) uses this alone: its
 * clients are agents, which send no `Origin`, so a request that carries a foreign one is a browser
 * (a DNS-rebinding or cross-site attempt) and is refused before anything else happens.
 */
export function checkOrigin(request: Request): SameOriginResult {
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site") return fail("cross_site");

  const origin = request.headers.get("origin");
  if (origin !== null) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return fail("origin_mismatch");
    }
    const own = ownOrigins(request);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!own.hosts.has(parsed.host.toLowerCase()) || !own.schemes.has(scheme)) {
      return fail("origin_mismatch");
    }
    // An Origin is only its scheme, host and port: anything more is not one a browser sends.
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.username !== "") {
      return fail("origin_mismatch");
    }
  }
  return { ok: true };
}

/** Checks the three rules above. Never throws and never reads the body. */
export function requireSameOrigin(request: Request): SameOriginResult {
  const origin = checkOrigin(request);
  if (!origin.ok) return origin;
  if (!isJson(request.headers.get("content-type"))) return fail("json_required");
  return { ok: true };
}
