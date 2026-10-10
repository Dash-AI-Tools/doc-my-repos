import { describe, expect, it } from "vitest";

import * as route from "./route";

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
      const res = route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    },
  );
});
