import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@docmyrepos/server/internal/comments/read-api", () => ({
  handleAdminListComments: mocks.list,
}));

import * as route from "./route";

// These tests check the route wiring. A gated route confirms the signed-in user in the tenant's
// database first; the e2e switch makes that the fixed admin without a database.
beforeAll(() => {
  vi.stubEnv("E2E_AUTH_BYPASS", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("/api/admin/comments route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic, runs on Node.js and hands GET to the admin list handler", async () => {
    expect([route.dynamic, route.runtime]).toEqual(["force-dynamic", "nodejs"]);
    mocks.list.mockResolvedValue(new Response("{}"));
    const request = new Request("http://localhost/api/admin/comments");
    await route.GET(request);
    expect(mocks.list).toHaveBeenCalledWith(request, {
      db: expect.any(Function),
      enabled: expect.any(Function),
      access: expect.any(Object),
    });
  });

  it.each(["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const)(
    "refuses %s with Allow: GET",
    async (m) => {
      const res = await route[m]();
      expect([res.status, res.headers.get("allow")]).toEqual([405, "GET"]);
    },
  );
});
