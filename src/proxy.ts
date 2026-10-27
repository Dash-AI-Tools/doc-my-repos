import { createProxy } from "@docmyrepos/server/proxy";

/**
 * The Next.js proxy (security headers, CSP nonce and the session gate), from the server package.
 * See `packages/server/src/proxy.ts`.
 */
export const proxy = createProxy();

export const config = {
  // Everything except the hashed build output (PROXY_MATCHER); Next.js reads this statically.
  matcher: ["/((?!_next/static/).*)"],
};
