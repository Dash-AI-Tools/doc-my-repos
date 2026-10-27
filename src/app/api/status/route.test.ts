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

describe("/api/status route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"] as const)(
    "refuses %s with Allow: GET",
    async (method) => {
      const res = await route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    },
  );
});
