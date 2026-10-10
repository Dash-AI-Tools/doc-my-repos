import type { NextConfig } from "next";

import { STATIC_ASSET_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  agentRules: false,
  // No `X-Powered-By: Next.js`.
  poweredByHeader: false,
  // Security headers (task 12.1): `src/proxy.ts` sets them, CSP included, on everything except
  // the build output under /_next/static, which the proxy skips; that gets the baseline here.
  // Only that path: a header set here is never overwritten by a route (the first value wins).
  async headers() {
    return [{ source: "/_next/static/:path*", headers: STATIC_ASSET_HEADERS }];
  },
};

export default nextConfig;
