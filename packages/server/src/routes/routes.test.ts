import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TENANT } from "@docmyrepos/core";

import { loadConfig } from "../app/config";
import type { RequestContext } from "../app/types";
import { ROUTE_MODULES, coreRoutes, type RouteHandler, type RouteName } from "./index";

const publicAccess = vi.hoisted(() => ({ allowed: false, asked: [] as string[] }));
vi.mock("../public-access/reader", () => ({
  anonymousMayUse: async (_ctx: unknown, need: string) => {
    publicAccess.asked.push(need);
    return publicAccess.allowed;
  },
}));

const defaultContext = async () =>
  ({
    tenant: DEFAULT_TENANT,
    user: async () => null,
    can: async () => false,
  }) as unknown as RequestContext;
const ENV = { config: loadConfig({}) };

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

describe("core routes", () => {
  const names = Object.keys(ROUTE_MODULES) as RouteName[];

  it.each(names)("%s: the manifest lists exactly the methods its module exports", async (name) => {
    const loaded = (await ROUTE_MODULES[name].load()) as Record<string, unknown>;
    const exported = METHODS.filter((m) => typeof loaded[m] === "function");
    expect([...ROUTE_MODULES[name].methods].sort()).toEqual(exported.sort());
  });

  it("binds a handler for every method of every route", () => {
    const routes = coreRoutes(defaultContext, ENV);
    for (const name of names) {
      expect(Object.keys(routes[name]).sort(), name).toEqual(
        [...ROUTE_MODULES[name].methods].sort(),
      );
    }
  });

  it("delegates to the route module, passing the request and context through", async () => {
    const response = await coreRoutes(defaultContext, ENV).health.POST!(
      new Request("http://localhost/api/health"),
    );
    expect(response.status).toBe(405);
  });

  it("answers a request that matches no tenant with a generic 404, loading no route code", async () => {
    const load = vi.spyOn(ROUTE_MODULES.search, "load");
    const response = await coreRoutes(async () => null, ENV).search.GET!(
      new Request("http://unknown.example/api/search?q=x"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not Found\n");
    expect(load).not.toHaveBeenCalled();
  });

  it("lets resolveTenant read a webhook's body, and still hands the handler the whole body", async () => {
    vi.spyOn(ROUTE_MODULES.githubWebhook, "load").mockResolvedValue({
      POST: async (request: Request) => new Response(await request.text()),
    } as never);
    const seen: string[] = [];
    const contextFor = async (request: Request) => {
      seen.push(await request.text());
      return defaultContext();
    };
    const response = await coreRoutes(contextFor, ENV).githubWebhook.POST!(
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        body: '{"installation":{"id":7}}',
      }),
    );
    expect(seen).toEqual(['{"installation":{"id":7}}']);
    expect(await response.text()).toBe('{"installation":{"id":7}}');
  });
});

describe("anonymous access to routes (public access)", () => {
  type Marked = { anonymous?: "content" | "search" | "ask" };
  const mark = (name: RouteName, need: "content" | "search" | "ask" | undefined) => {
    const route = ROUTE_MODULES[name] as Marked;
    if (need === undefined) delete route.anonymous;
    else route.anonymous = need;
  };
  const signedIn = async () =>
    ({
      tenant: DEFAULT_TENANT,
      user: async () => ({ id: 1, email: "a@example.com", role: "user" }),
      can: async () => true,
    }) as unknown as RequestContext;

  afterEach(() => {
    mark("status", undefined);
    publicAccess.allowed = false;
    publicAccess.asked.length = 0;
    vi.restoreAllMocks();
  });

  it("answers 401 to an anonymous request on every route that is not public or marked, even when everything is public", async () => {
    publicAccess.allowed = true;
    const routes = coreRoutes(defaultContext, ENV);
    const gated = (Object.keys(ROUTE_MODULES) as RouteName[]).filter(
      (name) => !("public" in ROUTE_MODULES[name]) && !("anonymous" in ROUTE_MODULES[name]),
    );
    expect(gated.length).toBeGreaterThan(20);
    for (const name of gated) {
      const [method] = ROUTE_MODULES[name].methods;
      const handlers = routes[name] as unknown as Record<string, RouteHandler>;
      const response = await handlers[method as string]!(
        new Request("http://localhost/api/x", { method }),
      );
      expect(response.status, `${name} ${method}`).toBe(401);
    }
    expect(publicAccess.asked).toEqual([]);
  });

  it("serves an anonymous request on a marked route only while public access allows its need", async () => {
    vi.spyOn(ROUTE_MODULES.status, "load").mockResolvedValue({
      GET: async () => new Response("served"),
    } as never);
    mark("status", "search");
    const routes = coreRoutes(defaultContext, ENV);
    const get = () => routes.status.GET!(new Request("http://localhost/api/status"));

    publicAccess.allowed = false;
    expect((await get()).status).toBe(401);
    publicAccess.allowed = true;
    const served = await get();
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("served");
    expect(publicAccess.asked).toEqual(["search", "search"]);
  });

  it("marks the image route for reading content, so images of public repositories reach anonymous visitors", async () => {
    expect((ROUTE_MODULES.asset as Marked).anonymous).toBe("content");
    vi.spyOn(ROUTE_MODULES.asset, "load").mockResolvedValue({
      GET: async () => new Response("image"),
    } as never);
    const get = () =>
      coreRoutes(defaultContext, ENV).asset.GET!(
        new Request("http://localhost/api/asset/acme/handbook/x.png"),
      );
    publicAccess.allowed = false;
    expect((await get()).status).toBe(401);
    publicAccess.allowed = true;
    expect((await get()).status).toBe(200);
    expect(publicAccess.asked).toEqual(["content", "content"]);
  });

  it("does not ask public access for a signed-in user, and keeps the content.read check", async () => {
    vi.spyOn(ROUTE_MODULES.status, "load").mockResolvedValue({
      GET: async () => new Response("served"),
    } as never);
    mark("status", "content");
    const ok = await coreRoutes(signedIn, ENV).status.GET!(new Request("http://localhost/x"));
    expect(ok.status).toBe(200);
    const denied = await coreRoutes(
      async () => ({ ...(await signedIn()), can: async () => false }) as RequestContext,
      ENV,
    ).status.GET!(new Request("http://localhost/x"));
    expect(denied.status).toBe(403);
    expect(publicAccess.asked).toEqual([]);
  });
});
