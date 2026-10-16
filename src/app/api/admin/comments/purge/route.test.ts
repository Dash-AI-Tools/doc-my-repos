import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ purge: vi.fn() }));
vi.mock("@/server/comments/service", () => ({ adminPurge: mocks.purge }));

import * as route from "./route";

describe("/api/admin/comments/purge route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic, runs on Node.js and answers the removed count", async () => {
    expect([route.dynamic, route.runtime]).toEqual(["force-dynamic", "nodejs"]);
    mocks.purge.mockResolvedValue({ ok: true, status: 200, removed: 3 });
    const res = await route.POST(new Request("http://localhost/x", { method: "POST" }));
    expect([res.status, await res.json()]).toEqual([200, { removed: 3 }]);
  });

  it("answers a refusal with the number of live comments left alone", async () => {
    mocks.purge.mockResolvedValue({
      ok: false,
      status: 409,
      code: "not_purgeable",
      error: "Live comments on existing documents cannot be removed permanently",
      refused: 2,
    });
    const res = await route.POST(new Request("http://localhost/x", { method: "POST" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "not_purgeable", refused: 2 });
  });

  it.each(["GET", "HEAD", "PUT", "PATCH", "DELETE"] as const)(
    "refuses %s with Allow: POST",
    (m) => {
      const res = route[m]();
      expect([res.status, res.headers.get("allow")]).toEqual([405, "POST"]);
    },
  );
});
