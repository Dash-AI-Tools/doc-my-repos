import { afterEach, describe, expect, it, vi } from "vitest";

import { STATIC_ASSET_HEADERS } from "@docmyrepos/core/internal/security-headers";

import { withDocMyRepos } from "./next";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("withDocMyRepos", () => {
  it("compiles the packages, hides X-Powered-By and aliases the apidom entry", () => {
    const config = withDocMyRepos();
    expect(config.transpilePackages).toEqual([
      "@docmyrepos/core",
      "@docmyrepos/server",
      "@docmyrepos/ui",
    ]);
    expect(config.poweredByHeader).toBe(false);
    expect(config.output).toBeUndefined();
    const alias = config.turbopack?.resolveAlias?.["@swagger-api/apidom-ns-openapi-3-1"];
    expect(alias).toMatch(/^\.\/node_modules\/.*apidom-ns-openapi-3-1\/.*\.cjs$/);
  });

  it("builds a standalone server only when NEXT_OUTPUT=standalone", () => {
    vi.stubEnv("NEXT_OUTPUT", "standalone");
    expect(withDocMyRepos().output).toBe("standalone");
  });

  it("sets the baseline headers on the build output and keeps the app's own headers", async () => {
    const own = { source: "/robots.txt", headers: [{ key: "X-Test", value: "1" }] };
    const config = withDocMyRepos({ headers: async () => [own] });
    expect(await config.headers?.()).toEqual([
      { source: "/_next/static/:path*", headers: STATIC_ASSET_HEADERS },
      own,
    ]);
  });

  it("lets the app add packages and options without losing the defaults", () => {
    const config = withDocMyRepos({
      agentRules: false,
      transpilePackages: ["@acme/plugin", "@docmyrepos/ui"],
      turbopack: { resolveAlias: { foo: "./bar" } },
    });
    expect(config.agentRules).toBe(false);
    expect(config.transpilePackages).toEqual([
      "@docmyrepos/core",
      "@docmyrepos/server",
      "@docmyrepos/ui",
      "@acme/plugin",
    ]);
    expect(config.turbopack?.resolveAlias).toMatchObject({ foo: "./bar" });
    expect(config.turbopack?.resolveAlias).toHaveProperty("@swagger-api/apidom-ns-openapi-3-1");
  });
});
