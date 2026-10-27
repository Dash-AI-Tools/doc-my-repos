import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTENSION_API_VERSION, type User } from "@docmyrepos/core";

import { createApp } from "../app/create-app";
import { resetRuntimeRegistry } from "../app/registry";
import type { Plugin } from "../app/types";

const CONFIG = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/unused",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};
const ORIGIN = "http://localhost";
const VIEWER: User = { id: 1, email: "v@example.com", role: "user" };

afterEach(() => resetRuntimeRegistry());

const handler = vi.fn(async (request: Request) => new Response(`ran ${request.method}`));

const billing: Plugin = {
  id: "billing",
  apiVersion: EXTENSION_API_VERSION,
  routes: [
    { method: "GET", path: "usage", handler },
    { method: "POST", path: "usage", handler },
    { method: "POST", path: "public/stripe", public: true, machine: true, handler },
    { method: "GET", path: "public/plans", public: true, handler },
    {
      method: "GET",
      path: "broken",
      handler: async () => {
        throw new Error("secret detail sk_live_123");
      },
    },
  ],
};

function appWith(user: User | null, options: { tenant?: boolean; canRead?: boolean } = {}) {
  return createApp({
    config: CONFIG,
    plugins: [billing],
    hooks: {
      resolveTenant: () => (options.tenant === false ? null : { id: "default", attributes: {} }),
      authenticate: async () => user,
      authorize: async (_ctx, action) => action !== "content.read" || options.canRead !== false,
    },
  });
}

const call = (
  app: ReturnType<typeof appWith>,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) => {
  const [plugin, ...rest] = path.split("/");
  return app.pluginRoutes[method]!(
    new Request(`${ORIGIN}/api/plugins/${path}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
    }),
    { params: Promise.resolve({ plugin: plugin!, path: rest }) },
  );
};

const sameOrigin = { origin: ORIGIN, "content-type": "application/json" };

describe("plugin route dispatch", () => {
  it("serves a declared route to a signed-in user", async () => {
    const response = await call(appWith(VIEWER), "GET", "billing/usage");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ran GET");
  });

  it("answers 404 for an unknown plugin or path and 405 for another method, before plugin code", async () => {
    handler.mockClear();
    const app = appWith(VIEWER);
    expect((await call(app, "GET", "nope/usage")).status).toBe(404);
    expect((await call(app, "GET", "billing/missing")).status).toBe(404);
    expect((await call(app, "GET", "billing/public/undeclared")).status).toBe(404);
    const wrong = await call(app, "DELETE", "billing/usage");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, POST");
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a session, and the content.read permission, for a route that is not public", async () => {
    handler.mockClear();
    expect((await call(appWith(null), "GET", "billing/usage")).status).toBe(401);
    expect((await call(appWith(VIEWER, { canRead: false }), "GET", "billing/usage")).status).toBe(
      403,
    );
    expect((await call(appWith(VIEWER, { tenant: false }), "GET", "billing/usage")).status).toBe(
      404,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("serves a public route signed out", async () => {
    expect((await call(appWith(null), "GET", "billing/public/plans")).status).toBe(200);
  });

  it("refuses a cross-origin unsafe request unless the route is a machine endpoint", async () => {
    const app = appWith(VIEWER);
    expect((await call(app, "POST", "billing/usage")).status).toBe(403);
    expect(
      (await call(app, "POST", "billing/usage", { ...sameOrigin, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await call(app, "POST", "billing/usage", sameOrigin)).status).toBe(200);
    expect((await call(appWith(null), "POST", "billing/public/stripe")).status).toBe(200);
  });

  it("answers 500 when the handler throws, without its message", async () => {
    const response = await call(appWith(VIEWER), "GET", "billing/broken");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sk_live_123");
  });
});
