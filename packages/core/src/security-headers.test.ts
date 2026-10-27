import { describe, expect, it } from "vitest";

import {
  BASELINE_HEADERS,
  HSTS_VALUE,
  PERMISSIONS_POLICY,
  ROUTE_OWNED_HEADERS,
  STATIC_ASSET_HEADERS,
  buildContentSecurityPolicy,
  generateNonce,
  hasMalformedPercentEncoding,
  isHttpsRequest,
  isValidNonce,
  responseSecurityHeaders,
} from "./security-headers";

const NONCE = "AAECAwQFBgcICQoLDA0ODw==";

/** The policy as a map of directive name to its source list. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((part) => {
      const [name = "", ...sources] = part.split(" ");
      return [name, sources];
    }),
  );
}

const PRODUCTION_HTTP =
  "default-src 'none'; " +
  `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'; ` +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "manifest-src 'self'; " +
  "frame-src 'none'; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'self'";

describe("generateNonce", () => {
  it("returns 128 random bits as base64, different every call", () => {
    const nonces = new Set(Array.from({ length: 1000 }, generateNonce));
    expect(nonces.size).toBe(1000);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
      expect(isValidNonce(nonce)).toBe(true);
    }
  });
});

describe("isValidNonce", () => {
  it.each([null, undefined, "", "abc", `${NONCE} `, `${NONCE}"`, `'${NONCE}'`, "A".repeat(24)])(
    "rejects %j",
    (value) => {
      expect(isValidNonce(value)).toBe(false);
    },
  );
});

describe("buildContentSecurityPolicy", () => {
  it("production over plain http: the exact policy", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE })).toBe(PRODUCTION_HTTP);
  });

  it("production over https adds upgrade-insecure-requests and nothing else", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE, https: true })).toBe(
      `${PRODUCTION_HTTP}; upgrade-insecure-requests`,
    );
  });

  it("development adds 'unsafe-eval' to script-src only", () => {
    const dev = buildContentSecurityPolicy({ nonce: NONCE, dev: true });
    expect(dev).toBe(PRODUCTION_HTTP.replace("'strict-dynamic'", "'strict-dynamic' 'unsafe-eval'"));
    expect(directives(dev).get("script-src")).toContain("'unsafe-eval'");
  });

  it("puts the nonce in script-src and nowhere else", () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: NONCE }));
    for (const [name, sources] of policy) {
      expect(sources.includes(`'nonce-${NONCE}'`), name).toBe(name === "script-src");
    }
  });

  it("style-src has no nonce or hash, which would switch off 'unsafe-inline'", () => {
    const styles = directives(buildContentSecurityPolicy({ nonce: NONCE })).get("style-src");
    expect(styles).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it.each([
    ["production", { nonce: NONCE }],
    ["production https", { nonce: NONCE, https: true }],
    ["development", { nonce: NONCE, dev: true }],
  ])("%s: no 'unsafe-inline' in script-src, no wildcards, no data:/blob: anywhere", (_, opts) => {
    const policy = buildContentSecurityPolicy(opts);
    const map = directives(policy);
    expect(map.get("script-src")).not.toContain("'unsafe-inline'");
    expect(map.get("script-src")).not.toContain("https:");
    for (const [, sources] of map) {
      expect(sources).not.toContain("*");
      expect(sources.some((s) => s.includes("*"))).toBe(false);
      expect(sources).not.toContain("data:");
      expect(sources).not.toContain("blob:");
      expect(sources).not.toContain("http:");
    }
  });

  it("never allows eval in production", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE })).not.toContain("unsafe-eval");
    expect(buildContentSecurityPolicy({ nonce: NONCE, https: true })).not.toContain("unsafe-eval");
  });

  it("denies by default and locks framing, plugins, base and forms", () => {
    const map = directives(buildContentSecurityPolicy({ nonce: NONCE }));
    expect(map.get("default-src")).toEqual(["'none'"]);
    expect(map.get("frame-ancestors")).toEqual(["'none'"]);
    expect(map.get("frame-src")).toEqual(["'none'"]);
    expect(map.get("object-src")).toEqual(["'none'"]);
    expect(map.get("base-uri")).toEqual(["'none'"]);
    expect(map.get("form-action")).toEqual(["'self'"]);
    expect(map.get("connect-src")).toEqual(["'self'"]);
    // no worker-src: workers fall back to default-src 'none' (Mermaid uses none)
    expect(map.has("worker-src")).toBe(false);
  });

  it("refuses a nonce it did not generate, so header text cannot be smuggled in", () => {
    for (const nonce of ["", "abc", `${NONCE}'; script-src *`, `${NONCE} 'unsafe-inline'`]) {
      expect(() => buildContentSecurityPolicy({ nonce })).toThrow(/nonce/);
    }
  });

  it("report seam: emits report-uri for a same-origin path or an https URL only", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE, reportUri: "/api/csp-report" })).toBe(
      `${PRODUCTION_HTTP}; report-uri /api/csp-report`,
    );
    expect(
      buildContentSecurityPolicy({ nonce: NONCE, reportUri: "https://reports.example.com/csp" }),
    ).toMatch(/; report-uri https:\/\/reports\.example\.com\/csp$/);
    for (const reportUri of [
      "//evil.example",
      "http://x.example",
      "/a; script-src *",
      "",
      "/a b",
    ]) {
      expect(() => buildContentSecurityPolicy({ nonce: NONCE, reportUri })).toThrow(/reportUri/);
    }
  });
});

describe("baseline headers", () => {
  const map = new Map(BASELINE_HEADERS);

  it("has the exact values", () => {
    expect(Object.fromEntries(map)).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": PERMISSIONS_POLICY,
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-DNS-Prefetch-Control": "off",
      "X-Permitted-Cross-Domain-Policies": "none",
    });
  });

  it("Permissions-Policy denies powerful features and allows clipboard-write for us only", () => {
    const features = new Map(
      PERMISSIONS_POLICY.split(", ").map((entry) => entry.split("=") as [string, string]),
    );
    expect(features.get("clipboard-write")).toBe("(self)");
    for (const denied of [
      "camera",
      "microphone",
      "geolocation",
      "payment",
      "usb",
      "clipboard-read",
    ]) {
      expect(features.get(denied), denied).toBe("()");
    }
    expect([...features.values()].every((v) => v === "()" || v === "(self)")).toBe(true);
    expect(PERMISSIONS_POLICY).not.toContain("*");
    // Chromium reports unknown features in the console
    expect(features.has("web-share")).toBe(false);
    expect(features.has("interest-cohort")).toBe(false);
  });

  it("the static asset headers are the baseline, without CSP or HSTS", () => {
    expect(STATIC_ASSET_HEADERS).toEqual(BASELINE_HEADERS.map(([key, value]) => ({ key, value })));
    const keys = STATIC_ASSET_HEADERS.map((h) => h.key.toLowerCase());
    expect(keys).not.toContain("content-security-policy");
    expect(keys).not.toContain("strict-transport-security");
  });

  it("HSTS: two years with subdomains, no preload", () => {
    expect(HSTS_VALUE).toBe("max-age=63072000; includeSubDomains");
  });
});

describe("responseSecurityHeaders", () => {
  const csp = buildContentSecurityPolicy({ nonce: NONCE });
  const names = (headers: Array<[string, string]>) => headers.map(([key]) => key.toLowerCase());

  it("pages and route handlers: CSP plus the baseline, HSTS only for production over https", () => {
    const http = responseSecurityHeaders({ pathname: "/", csp, production: true, https: false });
    expect(http).toEqual([["Content-Security-Policy", csp], ...BASELINE_HEADERS]);
    const https = responseSecurityHeaders({ pathname: "/", csp, production: true, https: true });
    expect(https).toEqual([
      ["Content-Security-Policy", csp],
      ...BASELINE_HEADERS,
      ["Strict-Transport-Security", HSTS_VALUE],
    ]);
    const dev = responseSecurityHeaders({ pathname: "/", csp, production: false, https: true });
    expect(names(dev)).not.toContain("strict-transport-security");
    const api = responseSecurityHeaders({
      pathname: "/api/search",
      csp,
      production: true,
      https: false,
    });
    expect(api).toEqual(http);
  });

  it("leaves the image proxy's own headers alone", () => {
    const owned = ROUTE_OWNED_HEADERS.find((r) => r.prefix === "/api/asset/")?.headers;
    expect(owned).toEqual(
      new Set([
        "content-security-policy",
        "referrer-policy",
        "x-content-type-options",
        "cross-origin-resource-policy",
      ]),
    );
    const asset = responseSecurityHeaders({
      pathname: "/api/asset/acme/repo/docs/a.png",
      csp,
      production: true,
      https: true,
    });
    expect(names(asset)).toEqual([
      "permissions-policy",
      "x-frame-options",
      "cross-origin-opener-policy",
      "x-dns-prefetch-control",
      "x-permitted-cross-domain-policies",
      "strict-transport-security",
    ]);
  });

  it("only the asset route itself is exempt, not look-alike paths", () => {
    for (const pathname of ["/api/assets/x", "/api/asset", "/acme/api/asset/x", "/API/asset/x"]) {
      expect(
        names(responseSecurityHeaders({ pathname, csp, production: true, https: false })),
      ).toContain("content-security-policy");
    }
  });
});

describe("isHttpsRequest", () => {
  it.each([
    ["https:", null, true],
    ["http:", null, false],
    ["http:", "https", true],
    ["http:", "HTTPS", true],
    ["http:", "https, http", true],
    ["http:", "http, https", false],
    ["http:", "", false],
    ["http:", "httpsx", false],
  ])("protocol %s, X-Forwarded-Proto %j -> %s", (protocol, forwarded, expected) => {
    expect(isHttpsRequest(protocol, forwarded)).toBe(expected);
  });
});

describe("hasMalformedPercentEncoding", () => {
  it.each([
    "/acme/%E0%A4%A",
    "/api/%E0%A4%A",
    "/%",
    "/a%",
    "/a%2",
    "/a%zz",
    "/a%G0",
    "/acme/%C3%28",
    "/acme/%FF",
    "/acme/%ED%A0%80", // UTF-16 surrogate encoded in UTF-8
    "/acme/%C0%AF", // overlong "/"
  ])("flags %s", (path) => {
    expect(hasMalformedPercentEncoding(path)).toBe(true);
  });

  it.each([
    "/",
    "/acme/api-service",
    "/acme/caf%C3%A9",
    "/acme/a%20b%25c",
    "/acme/%2F",
    "/acme/%e2%9c%93",
    "/acme/100%25",
  ])("accepts %s", (path) => {
    expect(hasMalformedPercentEncoding(path)).toBe(false);
  });
});
