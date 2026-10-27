import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TENANT } from "@docmyrepos/core";

import { loadConfig } from "../app/config";
import type { RequestContext } from "../app/types";
import { ROUTE_MODULES, coreRoutes, type RouteName } from "./index";

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
