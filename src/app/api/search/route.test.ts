import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as route from "./route";

// These tests check the route wiring. A gated route confirms the signed-in user in the tenant's
// database first; the e2e switch makes that the fixed admin without a database.
beforeAll(() => {
  vi.stubEnv("E2E_AUTH_BYPASS", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("/api/search route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it("answers an empty query without a database", async () => {
    const res = await route.GET(new Request("http://localhost/api/search"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ q: "", total: 0, hits: [], seeAll: "/search" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"] as const)(
    "refuses %s with Allow: GET",
    async (method) => {
      const res = await route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    },
  );
});
