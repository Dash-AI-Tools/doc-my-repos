import {
  unstable_doesMiddlewareMatch,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../next.config";
import { BASELINE_HEADERS, HSTS_VALUE, buildContentSecurityPolicy } from "./lib/security-headers";
import { SESSION_COOKIE } from "./server/auth/session";
import { config, proxy } from "./proxy";

/**
 * `src/proxy.ts` as Next.js runs it: a `NextRequest` in, a `NextResponse` out. `NextResponse.next`
 * passes request-header overrides to the app as `x-middleware-request-<name>` headers on the
 * response object (Next.js strips them before the response leaves the server).
 */

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, "http://127.0.0.1:3000"), { headers });

const NONCE_IN_CSP = /'nonce-([A-Za-z0-9+/]{22}==)'/;

function cspNonce(response: Response): string {
  const nonce = NONCE_IN_CSP.exec(response.headers.get("content-security-policy") ?? "")?.[1];
  expect(nonce).toBeDefined();
  return nonce as string;
}

beforeEach(() => {
  vi.stubEnv("E2E_AUTH_BYPASS", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy: nonce and CSP", () => {
  it("passes a fresh nonce to the app and puts the same one in the CSP", async () => {
    const response = await proxy(request("/acme/api-service"));
    const nonce = cspNonce(response);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    // Next.js reads the nonce for its own scripts from the request's CSP header
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(
      response.headers.get("content-security-policy"),
    );
    expect(response.headers.get("content-security-policy")).toBe(
      buildContentSecurityPolicy({ nonce }),
    );
  });

  it("never reuses a nonce across requests", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i++) nonces.add(cspNonce(await proxy(request("/"))));
    expect(nonces.size).toBe(200);
  });

  it("overwrites a nonce or CSP the client sent", async () => {
    const forged = "AAAAAAAAAAAAAAAAAAAAAA==";
    const response = await proxy(
      request("/", { "x-nonce": forged, "content-security-policy": "script-src *" }),
    );
    const nonce = cspNonce(response);
    expect(nonce).not.toBe(forged);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).not.toContain(
      "script-src *",
    );
  });

  it("keeps the other request headers", async () => {
    const response = await proxy(request("/", { "accept-language": "en" }));
    expect(response.headers.get("x-middleware-request-accept-language")).toBe("en");
  });

  it("production build: no 'unsafe-eval'; next dev: 'unsafe-eval'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await proxy(request("/"))).headers.get("content-security-policy")).not.toContain(
      "unsafe-eval",
    );
    vi.stubEnv("NODE_ENV", "development");
    expect((await proxy(request("/"))).headers.get("content-security-policy")).toContain(
      "'unsafe-eval'",
    );
  });
});

describe("proxy: response headers", () => {
  it("sets the baseline headers on pages and route handlers", async () => {
    for (const path of ["/", "/search?q=x", "/api/search?q=x", "/api/sync", "/no/such/page"]) {
      const response = await proxy(request(path));
      for (const [key, value] of BASELINE_HEADERS) {
        expect(response.headers.get(key), `${path} ${key}`).toBe(value);
      }
    }
  });

  it("HSTS and upgrade-insecure-requests only in production over https", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const plain = await proxy(request("/"));
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    expect(plain.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");

    const forwarded = await proxy(request("/", { "x-forwarded-proto": "https" }));
    expect(forwarded.headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    expect(forwarded.headers.get("content-security-policy")).toMatch(/upgrade-insecure-requests$/);

    const direct = await proxy(new NextRequest(new URL("https://docs.example.com/")));
    expect(direct.headers.get("strict-transport-security")).toBe(HSTS_VALUE);

    vi.stubEnv("NODE_ENV", "development");
    expect(
      (await proxy(request("/", { "x-forwarded-proto": "https" }))).headers.get(
        "strict-transport-security",
      ),
    ).toBeNull();
  });

  it("does not pre-set the headers the image proxy sets for itself", async () => {
    const response = await proxy(request("/api/asset/acme/repo/docs/diagram.svg"));
    for (const owned of [
      "content-security-policy",
      "referrer-policy",
      "x-content-type-options",
      "cross-origin-resource-policy",
    ]) {
      expect(response.headers.get(owned), owned).toBeNull();
    }
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).not.toBeNull();
  });
});

describe("proxy: malformed percent escapes", () => {
  it.each([
    "/acme/%E0%A4%A",
    "/api/%E0%A4%A",
    "/acme/repo/docs/%ZZ",
    "/acme/%C3%28",
    "/%",
    "/a%2",
    "/api/asset/acme/repo/%E0%A4%A.png",
    "/acme/%ED%A0%80",
  ])("answers %s with 400 and every header, before any route runs", async (path) => {
    const response = await proxy(request(path));
    expect(response.status).toBe(400);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Bad Request: the URL has a malformed percent escape.\n");
    expect(response.headers.get("content-security-policy")).toMatch(/^default-src 'none'/);
    for (const [key, value] of BASELINE_HEADERS) expect(response.headers.get(key)).toBe(value);
  });

  it("does not echo the path back", async () => {
    const response = await proxy(request("/<script>%E0"));
    expect(await response.text()).not.toContain("script");
  });

  it.each(["/acme/caf%C3%A9", "/acme/a%20b%25c/docs/x%2Fy", "/search?q=%E0%A4%A"])(
    "lets %s through (a malformed query is the page's business)",
    async (path) => {
      const response = await proxy(request(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );
});

describe("proxy matcher", () => {
  it.each([
    "/",
    "/acme/api-service",
    "/acme/api-service/docs/guides/setup",
    "/search",
    "/api/search",
    "/api/asset/acme/repo/docs/a.png",
    "/api/webhooks/github",
    "/favicon.ico",
    "/_next/image",
    "/_next/data/x.json",
    "/acme/_next/static/x",
  ])("runs on %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each([
    "/_next/static/chunks/app.js",
    "/_next/static/css/app.css",
    "/_next/static/media/x.woff2",
  ])("skips the build output %s", async (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
});

describe("next.config.ts", () => {
  it("removes X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("gives /_next/static the baseline headers, and nothing else gets headers from config", async () => {
    const asset = await unstable_getResponseFromNextConfig({
      url: "http://127.0.0.1/_next/static/chunks/app.js",
      nextConfig,
    });
    for (const [key, value] of BASELINE_HEADERS) expect(asset.headers.get(key)).toBe(value);
    expect(asset.headers.get("content-security-policy")).toBeNull();

    // headers set by config would win over a route's own (the image proxy's sandbox CSP)
    for (const url of ["/", "/api/asset/acme/repo/docs/a.svg", "/api/search"]) {
      const response = await unstable_getResponseFromNextConfig({
        url: `http://127.0.0.1${url}`,
        nextConfig,
      });
      for (const [key] of BASELINE_HEADERS) expect(response.headers.get(key), url).toBeNull();
    }
  });
});

describe("proxy: auth gate (access-control)", () => {
  const SECRET = "proxy-gate-test-secret-0123456789";

  // The file's top-level beforeEach stubs E2E_AUTH_BYPASS=1; these tests need the real gate.
  beforeEach(() => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    vi.stubEnv("SESSION_SECRET", SECRET);
  });

  async function gated(path: string, cookie?: string): Promise<NextResponse> {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    return proxy(request(path, headers));
  }

  it("redirects pages without a session to /login", async () => {
    for (const path of ["/", "/search", "/acme/repo"]) {
      const response = await gated(path);
      expect(response.status, path).toBe(307);
      expect(response.headers.get("location"), path).toMatch(/\/login$/);
    }
  });

  it("answers non-auth APIs with 401 JSON instead of a redirect", async () => {
    const response = await gated("/api/search?q=x");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("lets /login and /api/auth/* through without a session", async () => {
    for (const path of ["/login", "/api/auth/login", "/api/auth/logout"]) {
      const response = await gated(path);
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("lets the machine endpoints through without a session", async () => {
    for (const path of ["/api/sync", "/api/webhooks/github"]) {
      const response = await gated(path);
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("lets /api/health through but keeps /api/status behind the login", async () => {
    expect((await gated("/api/health")).headers.get("x-middleware-next")).toBe("1");
    expect((await gated("/api/status")).status).toBe(401);
  });

  it("lets the public logo through but keeps admin branding and other branding paths behind the login", async () => {
    expect((await gated("/api/branding/logo")).headers.get("x-middleware-next")).toBe("1");
    expect((await gated("/api/branding/logo?v=2")).headers.get("x-middleware-next")).toBe("1");
    for (const path of ["/api/admin/branding", "/api/admin/branding/logo", "/api/branding/other"]) {
      expect((await gated(path)).status, path).toBe(401);
    }
  });

  it("lets the favicon, touch icon and footer logos through without a session", async () => {
    for (const path of ["/icon.png", "/apple-icon.png", "/logo-black.png", "/logo-white.png"]) {
      expect((await gated(path)).headers.get("x-middleware-next"), path).toBe("1");
    }
    expect((await gated("/logo-black.png.bak")).status).not.toBe(200);
  });

  it("lets a valid session through and rejects tampered or expired ones", async () => {
    const { signSession, newSessionPayload } = await import("./server/auth/session");
    const valid = signSession(SECRET, newSessionPayload(1, "admin", 0));
    expect((await gated("/", valid)).headers.get("x-middleware-next")).toBe("1");

    const [data] = valid.split(".");
    expect((await gated("/", `${data}.bogus`)).status).toBe(307);
    const expired = signSession(SECRET, { uid: 1, role: "user", exp: Date.now() - 1, pwv: 0 });
    expect((await gated("/", expired)).status).toBe(307);
    expect((await gated("/api/search", `${data}.bogus`)).status).toBe(401);
  });
});
