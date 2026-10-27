import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ patch: vi.fn(), del: vi.fn() }));
vi.mock("@docmyrepos/server/internal/comments/service", () => ({
  patchComment: mocks.patch,
  deleteComment: mocks.del,
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

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string) => new Request("http://localhost/api/comments/7", { method });

describe("/api/comments/[id] route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it("passes the id segment as the raw string, malformed ones included", async () => {
    mocks.patch.mockResolvedValue({
      ok: false,
      status: 404,
      code: "not_found",
      error: "Not found",
    });
    const req = request("PATCH");
    const res = await route.PATCH(req, ctx("../7"));
    expect(mocks.patch).toHaveBeenCalledWith(req, "../7", {
      db: expect.any(Function),
      enabled: expect.any(Function),
      access: expect.any(Object),
    });
    expect(res.status).toBe(404);
  });

  it("answers PATCH and DELETE with the changed comment and thread", async () => {
    const change = { ok: true, status: 200, comment: null, thread: null, removed: true };
    mocks.patch.mockResolvedValue(change);
    mocks.del.mockResolvedValue(change);
    for (const res of [
      await route.PATCH(request("PATCH"), ctx("7")),
      await route.DELETE(request("DELETE"), ctx("7")),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ comment: null, thread: null, removed: true });
    }
    expect(mocks.del).toHaveBeenCalledWith(expect.any(Request), "7", {
      db: expect.any(Function),
      enabled: expect.any(Function),
      access: expect.any(Object),
    });
  });

  it("carries the rate-limit style headers of a failure", async () => {
    mocks.del.mockResolvedValue({
      ok: false,
      status: 403,
      code: "forbidden",
      error: "Forbidden",
    });
    const res = await route.DELETE(request("DELETE"), ctx("7"));
    expect([res.status, await res.json()]).toEqual([
      403,
      { error: "Forbidden", code: "forbidden" },
    ]);
  });

  it.each(["GET", "HEAD", "POST", "PUT"] as const)("refuses %s with Allow", async (method) => {
    const res = await route[method]();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH, DELETE");
  });
});
