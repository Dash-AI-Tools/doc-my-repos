import { describe, expect, it } from "vitest";

import * as route from "./route";

describe("/api/status route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"] as const)(
    "refuses %s with Allow: GET",
    async (method) => {
      const res = route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    },
  );
});
