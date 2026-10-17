import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("@/server/mcp/endpoint", () => ({ handleMcpRequest: mocks.handle }));

import * as route from "./route";

const METHODS = ["POST", "GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"] as const;

describe("/api/mcp route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it("exports exactly the HTTP methods it hands to the endpoint, and nothing else", () => {
    const exported = Object.keys(route).filter((k) => k === k.toUpperCase());
    expect(exported.sort()).toEqual([...METHODS].sort());
  });

  it.each(METHODS)("hands %s to the endpoint with the request alone", async (method) => {
    mocks.handle.mockResolvedValue(new Response("ok", { status: 200 }));
    const request = new Request("http://localhost/api/mcp", { method });
    const res = await route[method](request);
    expect(res.status).toBe(200);
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.handle).toHaveBeenCalledWith(request);
  });

  it("returns the endpoint's answer unchanged", async () => {
    const answer = new Response('{"error":"x"}', { status: 418, headers: { "X-Test": "1" } });
    mocks.handle.mockResolvedValue(answer);
    const res = await route.POST(new Request("http://localhost/api/mcp", { method: "POST" }));
    expect(res).toBe(answer);
  });
});
