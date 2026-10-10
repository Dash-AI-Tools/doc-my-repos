import { NextResponse, type NextRequest } from "next/server";

import {
  NONCE_HEADER,
  buildContentSecurityPolicy,
  generateNonce,
  hasMalformedPercentEncoding,
  isHttpsRequest,
  responseSecurityHeaders,
} from "@/lib/security-headers";

/**
 * Next.js Proxy (the Next 16 name for middleware), task 12.1. Runs before every route except the
 * immutable build files under `/_next/static/` (see `config.matcher`), and only does cheap,
 * synchronous work: no database, no GitHub, no imports beyond the pure header builders.
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
 */
export function proxy(request: NextRequest): NextResponse {
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
