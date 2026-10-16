import { createRequire } from "node:module";
import { relative } from "node:path";

import type { NextConfig } from "next";

import { STATIC_ASSET_HEADERS } from "./src/lib/security-headers";

/**
 * Turbopack workaround for the API reference widget (Swagger UI, openapi-reference task 5.2).
 *
 * `@swagger-api/apidom-ns-openapi-3-1` registers `OpenApi3_1Element.refract` in a module that
 * imports back the index re-exporting it. Turbopack evaluates that ESM cycle in an order that
 * leaves `refract` unset, so every OpenAPI 3.1 spec logs `TypeError: x.refract is not a function`
 * in the browser (webpack and the CommonJS build are fine; 3.0 and Swagger 2.0 are not affected).
 * Resolving the package to its CommonJS entry avoids the cycle. The path is found through
 * swagger-ui-react's own dependency chain, so it follows version bumps. Drop this once the
 * installed swagger-ui-react builds clean under Turbopack (check with an OpenAPI 3.1 spec).
 */
function apidomOpenApi31Entry(): string {
  const root = process.cwd();
  const fromRoot = createRequire(`${root}/package.json`);
  const fromSwaggerUi = createRequire(fromRoot.resolve("swagger-ui-react"));
  const fromSwaggerClient = createRequire(fromSwaggerUi.resolve("swagger-client"));
  const entry = fromSwaggerClient.resolve("@swagger-api/apidom-ns-openapi-3-1");
  return `./${relative(root, entry)}`;
}

const nextConfig: NextConfig = {
  agentRules: false,
  // The Docker image builds with NEXT_OUTPUT=standalone (task 13.1): a self-contained server with
  // only the files it needs. Opt-in because `next start`, which `pnpm start` and the e2e run use,
  // does not serve a standalone build.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // No `X-Powered-By: Next.js`.
  poweredByHeader: false,
  turbopack: { resolveAlias: { "@swagger-api/apidom-ns-openapi-3-1": apidomOpenApi31Entry() } },
  // Security headers (task 12.1): `src/proxy.ts` sets them, CSP included, on everything except
  // the build output under /_next/static, which the proxy skips; that gets the baseline here.
  // Only that path: a header set here is never overwritten by a route (the first value wins).
  async headers() {
    return [{ source: "/_next/static/:path*", headers: STATIC_ASSET_HEADERS }];
  },
};

export default nextConfig;
