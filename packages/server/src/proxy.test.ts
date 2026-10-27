import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NextRequest } from "next/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROXY_MATCHER, createProxy } from "./proxy";

const request = (path: string) => new NextRequest(new URL(path, "http://localhost"));

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "session-secret-for-proxy-tests");
  vi.stubEnv("E2E_AUTH_BYPASS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createProxy", () => {
  it("gates everything but the core public paths by default", async () => {
    const proxy = createProxy();
    expect((await proxy(request("/pricing"))).status).toBe(307);
    expect((await proxy(request("/api/health"))).status).toBe(200);
  });

  it("lets a host add public paths, each covering what lies below it", async () => {
    const proxy = createProxy({ publicPaths: ["/pricing", "/signup/"] });
    expect((await proxy(request("/pricing"))).status).toBe(200);
    expect((await proxy(request("/pricing/teams"))).status).toBe(200);
    expect((await proxy(request("/signup"))).status).toBe(200);
    expect((await proxy(request("/pricingx"))).status).toBe(307);
    expect((await proxy(request("/api/search"))).status).toBe(401);
  });

  it("lets plugins' public routes and pages through, and gates the rest of each plugin", async () => {
    const proxy = createProxy();
    for (const path of [
      "/api/plugins/billing/public",
      "/api/plugins/billing/public/pricing",
      "/-/billing/public/plans",
    ]) {
      expect((await proxy(request(path))).status, path).toBe(200);
    }
    expect((await proxy(request("/api/plugins/billing/usage"))).status).toBe(401);
    expect((await proxy(request("/api/plugins/billing/publicity"))).status).toBe(401);
    expect((await proxy(request("/api/plugins/public"))).status).toBe(401);
    expect((await proxy(request("/-/billing/account"))).status).toBe(307);
    expect((await proxy(request("/-/billing"))).status).toBe(307);
  });

  it("lets a host replace the session pre-check", async () => {
    const isSignedIn = vi.fn((req: NextRequest) => req.headers.get("x-host-session") === "yes");
    const proxy = createProxy({ isSignedIn });
    const signedIn = new NextRequest(new URL("http://localhost/"), {
      headers: { "x-host-session": "yes" },
    });
    expect((await proxy(signedIn)).status).toBe(200);
    expect((await proxy(request("/"))).status).toBe(307);
    expect(isSignedIn).toHaveBeenCalledTimes(2);
  });

  it("exports the matcher a route-level proxy file spells out", () => {
    expect(PROXY_MATCHER).toEqual(["/((?!_next/static/).*)"]);
  });
});

describe("the proxy entrypoint stays Edge-safe", () => {
  const SRC = dirname(fileURLToPath(import.meta.url));
  const FORBIDDEN = /^(node:|pg$|pg\/|drizzle-orm|react$|react\/|react-dom|server-only$)/;

  /** Every module specifier reachable from `entry` through relative and package-internal imports. */
  function reachable(entry: string): { files: string[]; external: string[] } {
    const files: string[] = [];
    const external = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (files.includes(file)) continue;
      files.push(file);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
      for (const statement of source.statements) {
        if (
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const spec = statement.moduleSpecifier.text;
          const core = /^@docmyrepos\/core\/internal\/(.+)$/.exec(spec);
          if (spec.startsWith(".")) queue.push(`${resolve(dirname(file), spec)}.ts`);
          else if (core) queue.push(resolve(SRC, "../../core/src", `${core[1]}.ts`));
          else external.add(spec);
        }
      }
    }
    return { files, external: [...external].sort() };
  }

  it("imports no Node.js-only module, database code or React", () => {
    const { files, external } = reachable(resolve(SRC, "proxy.ts"));
    expect(files.length).toBeGreaterThan(1);
    expect(external.filter((spec) => FORBIDDEN.test(spec))).toEqual([]);
    expect(files.some((f) => /\/db\//.test(f))).toBe(false);
  });
});
