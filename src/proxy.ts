import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/server/auth/session";
import { verifySessionEdge } from "@/server/auth/edge-session";
import {
  NONCE_HEADER,
  buildContentSecurityPolicy,
  generateNonce,
  hasMalformedPercentEncoding,
  isHttpsRequest,
  responseSecurityHeaders,
} from "@/lib/security-headers";

/**
 * Test-only auth bypass for the Playwright suite: the e2e servers run with `E2E_AUTH_BYPASS=1`
 * (see `e2e/support/stack.ts`), so existing specs exercise content without a login dance. Never
 * set it in `.env`, `.env.example`, the Dockerfile or compose files; production never has it.
 */
function e2eAuthBypass(): boolean {
  return process.env.E2E_AUTH_BYPASS === "1";
}

/** Paths the auth gate never touches. */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    // Machine endpoints: authenticated by SYNC_SECRET and the webhook HMAC, not by a session.
    pathname === "/api/sync" ||
    pathname === "/api/webhooks/github" ||
    // Health check for the Docker HEALTHCHECK and load balancers: verdict only, no repository data
    // (`/api/status` lists repositories and stays behind the login).
    pathname === "/api/health" ||
    // Fixture pages for component tests (gated separately by E2E_FIXTURES, see e2e-fixtures.ts).
    pathname.startsWith("/e2e/")
  );
}

/**
 * Next.js Proxy (the Next 16 name for middleware), task 12.1. Runs before every route except the
 * immutable build files under `/_next/static/` (see `config.matcher`), and only does cheap work:
 * no database, no GitHub.
 *
 * 1. A path with a percent escape that does not decode (`/acme/%E0%A4%A`) is answered 400 here.
 *    Next.js would otherwise fail with a bare 500 before any page or route code runs.
 * 2. A fresh nonce per request goes to the app in the `x-nonce` request header (the root layout
 *    passes it to next-themes' inline script) and in the `Content-Security-Policy` request header,
 *    which Next.js reads to put the same nonce on its own scripts. Reading the nonce makes every
 *    page render per request: there is no static HTML to cache, which this app never had (pages
 *    read Postgres) except for the not-found page.
 * 3. The response gets the CSP and the other security headers (`src/lib/security-headers.ts`),
 *    except those a route owns: `/api/asset` keeps its own sandbox CSP.
 * 4. Auth gate (access-control): pages and non-auth APIs need a valid session cookie (signature +
 *    expiry checked here with WebCrypto; the database re-check in `current-user.ts` is the source
 *    of truth). Pages redirect to `/login`, APIs answer 401 JSON.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, protocol } = request.nextUrl;
  const production = process.env.NODE_ENV === "production";
  const https = isHttpsRequest(protocol, request.headers.get("x-forwarded-proto"));
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV === "development",
    https,
  });

  if (hasMalformedPercentEncoding(pathname)) {
    const response = new NextResponse("Bad Request: the URL has a malformed percent escape.\n", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
    for (const [key, value] of responseSecurityHeaders({ pathname: "/", csp, production, https })) {
      response.headers.set(key, value);
    }
    return response;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  if (!isPublicPath(pathname) && !e2eAuthBypass()) {
    const session = await verifySessionEdge(
      process.env.SESSION_SECRET?.trim() ?? "",
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    if (!session) {
      if (pathname.startsWith("/api/")) {
        const response = new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
        for (const [key, value] of responseSecurityHeaders({ pathname, csp, production, https })) {
          response.headers.set(key, value);
        }
        return response;
      }
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      const response = NextResponse.redirect(loginUrl);
      for (const [key, value] of responseSecurityHeaders({ pathname, csp, production, https })) {
        response.headers.set(key, value);
      }
      return response;
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of responseSecurityHeaders({ pathname, csp, production, https })) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  // Everything except the hashed build output, which gets its headers from next.config.ts.
  matcher: ["/((?!_next/static/).*)"],
};
