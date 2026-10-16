import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/server/comments/read-api", () => ({ handleAdminListComments: mocks.list }));

import * as route from "./route";

describe("/api/admin/comments route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic, runs on Node.js and hands GET to the admin list handler", async () => {
    expect([route.dynamic, route.runtime]).toEqual(["force-dynamic", "nodejs"]);
    mocks.list.mockResolvedValue(new Response("{}"));
    const request = new Request("http://localhost/api/admin/comments");
    await route.GET(request);
    expect(mocks.list).toHaveBeenCalledWith(request);
  });

  it.each(["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const)(
    "refuses %s with Allow: GET",
    (m) => {
      const res = route[m]();
      expect([res.status, res.headers.get("allow")]).toEqual([405, "GET"]);
    },
  );
});
