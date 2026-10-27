import type { HttpMethod, PluginPage } from "@docmyrepos/core";

import type { RequestContext } from "../app/types";
import { errorFields } from "../log";
import {
  forbiddenResponse,
  unauthorizedResponse,
  unknownTenantResponse,
  type ContextFor,
} from "../routes/index";
import { requireSameOrigin } from "../same-origin";
import type { PluginRegistry } from "./registry";

/** The dynamic segments of `/api/plugins/[plugin]/[...path]`. */
export interface PluginRouteParams {
  readonly plugin: string;
  readonly path?: readonly string[];
}

export type PluginRouteHandler = (
  request: Request,
  route: { readonly params: Promise<PluginRouteParams> },
) => Promise<Response>;

export const PLUGIN_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/**
 * Serves `/api/plugins/<id>/<path>` from the plugins' routes. Everything decided before plugin code
 * runs: an unknown plugin or path is 404 and a method the path does not take 405; the tenant is
 * resolved (404 when none); a route that is not public needs a signed-in user allowed to read
 * content (401, 403, as the core APIs); an unsafe method must pass the same-origin check unless the
 * route is a machine endpoint. A handler that throws is answered 500 and logged as
 * `plugin.failed` with the plugin's id only.
 */
export function pluginRouteHandlers(
  registry: PluginRegistry,
  contextFor: ContextFor,
): Readonly<Record<(typeof PLUGIN_METHODS)[number], PluginRouteHandler>> {
  const handle = (method: HttpMethod): PluginRouteHandler =>
    async function dispatch(request, route) {
      const { plugin: id, path = [] } = await route.params;
      const routes = (registry.plugin(id)?.routes ?? []).filter((r) => r.path === path.join("/"));
      if (routes.length === 0) return json(404, { error: "Not found" });
      const target = routes.find((r) => r.method === method);
      if (target === undefined) {
        return json(
          405,
          { error: "Method not allowed" },
          {
            allow: routes.map((r) => r.method).join(", "),
          },
        );
      }
      const ctx: RequestContext | null = await contextFor(request);
      if (ctx === null) return unknownTenantResponse();
      if (target.public !== true) {
        if ((await ctx.user()) === null) return unauthorizedResponse();
        if (!(await ctx.can("content.read"))) return forbiddenResponse();
      }
      if (!SAFE_METHODS.has(method) && target.machine !== true) {
        const origin = requireSameOrigin(request);
        if (!origin.ok) return json(origin.status, { error: origin.error });
      }
      try {
        return await target.handler(request, ctx);
      } catch (error) {
        ctx.log.error("plugin.failed", {
          plugin: id,
          part: "route",
          errorName: errorFields(error).errorName,
        });
        return json(500, { error: "Internal error" });
      }
    };
  return Object.freeze(
    Object.fromEntries(PLUGIN_METHODS.map((method) => [method, handle(method)])) as Record<
      (typeof PLUGIN_METHODS)[number],
      PluginRouteHandler
    >,
  );
}

/** The page a `/-/<id>/<segments>` request renders, and the segments below the page's path. */
export interface PluginPageMatch {
  readonly page: PluginPage<RequestContext, unknown>;
  readonly rest: readonly string[];
}

/**
 * The plugin page for `/-/<id>/<segments>`: the page whose path is the longest prefix of the
 * segments, or null. A `public/` path matches only a page declared public (`pluginProblems`).
 */
export function matchPluginPage(
  registry: Pick<PluginRegistry, "plugin">,
  id: string,
  segments: readonly string[],
): PluginPageMatch | null {
  let best: PluginPageMatch | null = null;
  for (const page of registry.plugin(id)?.pages ?? []) {
    const own = page.path.split("/");
    const prefix = own.every((segment, i) => segments[i] === segment);
    if (prefix && own.length > (best ? segments.length - best.rest.length : 0)) {
      best = { page, rest: segments.slice(own.length) };
    }
  }
  return best;
}
