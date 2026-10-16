import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock("@/server/comments/service", () => ({ adminDelete: mocks.del }));

import * as route from "./route";

describe("/api/admin/comments/[id] route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic, runs on Node.js and passes the raw id to adminDelete", async () => {
    expect([route.dynamic, route.runtime]).toEqual(["force-dynamic", "nodejs"]);
    mocks.del.mockResolvedValue({
      ok: true,
      status: 200,
      comment: null,
      thread: null,
      removed: true,
    });
    const request = new Request("http://localhost/api/admin/comments/9", { method: "DELETE" });
    const res = await route.DELETE(request, { params: Promise.resolve({ id: "9" }) });
    expect(mocks.del).toHaveBeenCalledWith(request, "9");
    expect(res.status).toBe(200);
  });

  it("returns 401 and 403 failures as fixed bodies", async () => {
    for (const [status, code, error] of [
      [401, "unauthorized", "Unauthorized"],
      [403, "forbidden", "Forbidden"],
    ] as const) {
      mocks.del.mockResolvedValue({ ok: false, status, code, error });
      const res = await route.DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
        params: Promise.resolve({ id: "9" }),
      });
      expect([res.status, await res.json()]).toEqual([status, { error, code }]);
    }
  });

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH"] as const)(
    "refuses %s with Allow: DELETE",
    (m) => {
      const res = route[m]();
      expect([res.status, res.headers.get("allow")]).toEqual([405, "DELETE"]);
    },
  );
});
