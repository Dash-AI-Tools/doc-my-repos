import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/server/comments/read-api", () => ({ handleListComments: mocks.list }));
vi.mock("@/server/comments/service", () => ({ createComment: mocks.create }));

import * as route from "./route";

describe("/api/comments route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it("hands GET to the list handler", async () => {
    mocks.list.mockResolvedValue(new Response("{}", { status: 200 }));
    const request = new Request("http://localhost/api/comments?repo=a/b&path=x.md");
    expect((await route.GET(request)).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(request);
  });

  it("turns a create result into the JSON response, with the changed comment and thread", async () => {
    mocks.create.mockResolvedValue({
      ok: true,
      status: 201,
      comment: { id: 1 },
      thread: { root: { id: 1 }, replies: [] },
      removed: false,
    });
    const res = await route.POST(new Request("http://localhost/api/comments", { method: "POST" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      comment: { id: 1 },
      thread: { root: { id: 1 }, replies: [] },
      removed: false,
    });
  });

  it("returns a failure as a fixed error body", async () => {
    mocks.create.mockResolvedValue({
      ok: false,
      status: 404,
      code: "not_found",
      error: "Not found",
    });
    const res = await route.POST(new Request("http://localhost/api/comments", { method: "POST" }));
    expect([res.status, await res.json()]).toEqual([
      404,
      { error: "Not found", code: "not_found" },
    ]);
  });

  it.each(["HEAD", "PUT", "PATCH", "DELETE"] as const)("refuses %s with Allow", (method) => {
    const res = route[method]();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
