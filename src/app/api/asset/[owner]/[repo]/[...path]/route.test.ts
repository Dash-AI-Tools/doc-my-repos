import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetDeps } from "@docmyrepos/server/internal/assets/serve";
import { PNG } from "@docmyrepos/server/internal/assets/test-images";

// These tests check the route wiring. A gated route confirms the signed-in user in the tenant's
// database first; the e2e switch makes that the fixed admin without a database.
beforeAll(() => {
  vi.stubEnv("E2E_AUTH_BYPASS", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const TOKEN = "ghs_SENTINEL_route_token_51d0";

const getFile = vi.fn(async () => ({ notModified: false as const, data: PNG, etag: null }));

const deps: AssetDeps = {
  findRepo: async (owner, name) =>
    owner.toLowerCase() === "acme" && name.toLowerCase() === "handbook"
      ? {
          githubId: 1,
          owner: "acme",
          name: "handbook",
          defaultBranch: "main",
          visibility: "private",
        }
      : null,
  isConfigured: () => true,
  github: { getFile },
  cache: null,
};

vi.mock("@docmyrepos/server/internal/assets/service", () => ({
  getAssetDeps: vi.fn(() => deps),
}));

const route = await import("./route");
const { getAssetDeps } = await import("@docmyrepos/server/internal/assets/service");

const url = (path: string) => `http://localhost/api/asset/${path}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/asset route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it("serves an image of a configured repository", async () => {
    const res = await route.GET(new Request(url("acme/handbook/docs/img/arch.png")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(getFile).toHaveBeenCalledExactlyOnceWith(
      "acme",
      "handbook",
      "docs/img/arch.png",
      expect.objectContaining({ ref: "main" }),
    );
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
  });

  it("answers HEAD without a body", async () => {
    const res = await route.HEAD(
      new Request(url("acme/handbook/docs/img/arch.png"), { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("refuses traversal and non-images without building the runtime", async () => {
    for (const path of ["acme/handbook/%2E%2E%2Fsecret.png", "acme/handbook/x.md"]) {
      const res = await route.GET(new Request(url(path)));
      expect([400, 415]).toContain(res.status);
    }
    expect(getAssetDeps).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
  });

  it("answers 404 for a repository that is not synced", async () => {
    const res = await route.GET(new Request(url("acme/other/a.png")));
    expect(res.status).toBe(404);
    expect(getFile).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "answers %s with 405 and Allow: GET, HEAD",
    async (method) => {
      const res = await route[method](
        new Request(url("acme/handbook/docs/img/arch.png"), { method, body: "x" }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(getAssetDeps).not.toHaveBeenCalled();
    },
  );
});
