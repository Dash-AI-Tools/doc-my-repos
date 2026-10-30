/**
 * The core API routes by name. Each entry is the set of HTTP methods its route file exports, and
 * each method handler loads the route's module on first use, so a route file pulls in only the
 * code of its own route. The route files under `src/app/api/` bind them:
 *
 *   export const { GET, HEAD } = app.routes.search;
 *
 * Before a route's code runs, the request is resolved to a tenant. A request that matches no
 * tenant is answered 404 with a generic body: no route module is loaded and nothing is read.
 * Every route not marked `public` then requires a signed-in user, confirmed in the tenant's
 * database (`authenticate`), and answers 401 without one, as the proxy does for a missing
 * cookie, and 403 when the `authorize` hook does not let that user read the portal
 * (`content.read`). A route marked `anonymous` also serves a visitor who is not signed in, but only
 * when public access allows what the route does (`anonymousMayUse`): the route's own code then
 * reads through the anonymous visibility filter. Unmarked routes never do. The public routes authenticate their callers themselves (login, the sync secret, the
 * webhook signature, MCP tokens) or serve nothing private (health, the logo). The route's handler
 * receives the request context as its third argument.
 */

import type { StartupConfig } from "../app/config";
import type { RequestContext } from "../app/types";
import { anonymousMayUse, type PublicNeed } from "../public-access/reader";

/** The second argument Next.js passes a route handler: the dynamic route parameters. */
export interface RouteContext {
  readonly params: Promise<Record<string, string | string[]>>;
}

/**
 * A route method handler. Next.js always passes both arguments; tests may leave them out for
 * routes that read neither.
 */
export type RouteHandler = (request?: Request, context?: RouteContext) => Promise<Response>;

/** What a route module may read of the app beyond the request: its startup configuration. */
export interface RouteEnv {
  readonly config: StartupConfig;
}

/** A method handler of a route module: the Next.js arguments, the request context, the app. */
export type ContextRouteHandler = (
  request: Request | undefined,
  context: RouteContext | undefined,
  ctx: RequestContext,
  env: RouteEnv,
) => Response | Promise<Response>;

/** Resolves a request to its context, or null when it matches no tenant. */
export type ContextFor = (request: Request) => Promise<RequestContext | null>;

/** The answer to a gated route without a signed-in user: the proxy's answer to a missing cookie. */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The answer to a signed-in user the `authorize` hook does not let read the portal. */
export function forbiddenResponse(): Response {
  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The answer to a request that matches no tenant: nothing about tenants, repositories or setup. */
export function unknownTenantResponse(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

type Module = Readonly<Record<string, unknown>>;

export const ROUTE_MODULES = {
  /** `/api/account/tokens/[id]` */
  accountToken: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./account-token"),
  },
  /** `/api/account/tokens` */
  accountTokens: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./account-tokens"),
  },
  /** `/api/admin/ask` */
  adminAsk: { methods: ["GET", "PUT"], load: () => import("./admin-ask") },
  /** `/api/admin/public-access` */
  adminPublicAccess: {
    methods: ["GET", "PUT"],
    load: () => import("./admin-public-access"),
  },
  /** `/api/admin/ask/credentials` */
  adminAskCredentials: { methods: ["PUT"], load: () => import("./admin-ask-credentials") },
  /** `/api/admin/ask/test` */
  adminAskTest: { methods: ["POST"], load: () => import("./admin-ask-test") },
  /** `/api/admin/branding` */
  adminBranding: { methods: ["GET", "PUT", "DELETE"], load: () => import("./admin-branding") },
  /** `/api/admin/branding/logo` */
  adminBrandingLogo: { methods: ["PUT", "DELETE"], load: () => import("./admin-branding-logo") },
  /** `/api/admin/comments/[id]` */
  adminComment: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./admin-comment"),
  },
  /** `/api/admin/comments` */
  adminComments: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./admin-comments"),
  },
  /** `/api/admin/comments/purge` */
  adminCommentsPurge: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./admin-comments-purge"),
  },
  /** `/api/admin/folders/[id]` */
  adminFolder: { methods: ["PATCH", "DELETE"], load: () => import("./admin-folder") },
  /** `/api/admin/folders` */
  adminFolders: { methods: ["GET", "POST"], load: () => import("./admin-folders") },
  /** `/api/admin/folders/starred` */
  adminFoldersStarred: { methods: ["PUT"], load: () => import("./admin-folders-starred") },
  /** `/api/admin/repos` */
  adminRepos: { methods: ["GET", "PATCH"], load: () => import("./admin-repos") },
  /** `/api/admin/repos/starred` */
  adminReposStarred: { methods: ["PUT"], load: () => import("./admin-repos-starred") },
  /** `/api/admin/settings` */
  adminSettings: { methods: ["GET", "PUT"], load: () => import("./admin-settings") },
  /** `/api/admin/settings/test` */
  adminSettingsTest: { methods: ["POST"], load: () => import("./admin-settings-test") },
  /** `/api/admin/sync` */
  adminSync: { methods: ["POST"], load: () => import("./admin-sync") },
  /** `/api/admin/tokens/[id]` */
  adminToken: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./admin-token"),
  },
  /** `/api/admin/tokens` */
  adminTokens: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./admin-tokens"),
  },
  /** `/api/admin/users/[id]` */
  adminUser: { methods: ["PATCH"], load: () => import("./admin-user") },
  /** `/api/admin/users` */
  adminUsers: { methods: ["GET", "POST"], load: () => import("./admin-users") },
  /** `/api/ask` */
  ask: {
    // Anonymous Ask over public repositories, when an admin allows it (public access).
    anonymous: "ask",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./ask"),
  },
  /** `/api/asset/[owner]/[repo]/[...path]` */
  asset: {
    // Images of public repositories are shown to visitors without a session (public access).
    anonymous: "content",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./asset"),
  },
  /** `/api/auth/login` */
  authLogin: {
    public: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./auth-login"),
  },
  /** `/api/auth/logout` */
  authLogout: {
    public: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./auth-logout"),
  },
  /** `/api/branding/logo` */
  brandingLogo: { public: true, methods: ["GET", "HEAD"], load: () => import("./branding-logo") },
  /** `/api/comments/[id]` */
  comment: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./comment"),
  },
  /** `/api/comments` */
  comments: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./comments"),
  },
  /** `/api/webhooks/github` */
  githubWebhook: {
    public: true,
    // A host resolves a webhook's tenant from its payload (the installation), so it gets a copy.
    tenantFromBody: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./github-webhook"),
  },
  /** `/api/health` */
  health: {
    public: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./health"),
  },
  /** `/api/mcp` */
  mcp: {
    public: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    load: () => import("./mcp"),
  },
  /** `/api/search` */
  search: {
    // Anonymous search over public repositories, when an admin allows it (public access).
    anonymous: "search",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./search"),
  },
  /** `/api/status` */
  status: {
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./status"),
  },
  /** `/api/sync` */
  sync: {
    public: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    load: () => import("./sync"),
  },
} as const satisfies Record<
  string,
  {
    methods: readonly string[];
    load: () => Promise<Module>;
    public?: true;
    /**
     * Also served to a visitor who is not signed in, while public access allows this need (public
     * access design decision 3). The route's code must then read through the anonymous filter.
     */
    anonymous?: PublicNeed;
    /** `resolveTenant` receives a clone of the request, so it may read the body. */
    tenantFromBody?: true;
  }
>;

export type RouteName = keyof typeof ROUTE_MODULES;

export type CoreRoutes = {
  readonly [N in RouteName]: Readonly<
    Record<(typeof ROUTE_MODULES)[N]["methods"][number], RouteHandler>
  >;
};

// Tests call some handlers without a request; the tenant is still resolved, from the root URL.
const NO_REQUEST = "http://localhost/";

function bind(
  name: RouteName,
  contextFor: ContextFor,
  env: RouteEnv,
): Readonly<Record<string, RouteHandler>> {
  const route = ROUTE_MODULES[name];
  const handlers: Record<string, RouteHandler> = {};
  for (const method of route.methods) {
    handlers[method] = async (request, context) => {
      const incoming = request ?? new Request(NO_REQUEST);
      const ctx = await contextFor("tenantFromBody" in route ? incoming.clone() : incoming);
      if (ctx === null) return unknownTenantResponse();
      if (!("public" in route)) {
        if ((await ctx.user()) === null) {
          // Public access: only a route marked `anonymous`, and only while what it does is allowed.
          const need = "anonymous" in route ? (route.anonymous as PublicNeed) : null;
          if (need === null || !(await anonymousMayUse(ctx, need))) return unauthorizedResponse();
        } else if (!(await ctx.can("content.read"))) {
          return forbiddenResponse();
        }
      }
      const loaded: Module = await route.load();
      const handler = loaded[method] as ContextRouteHandler;
      return handler(request, context, ctx, env);
    };
  }
  return Object.freeze(handlers);
}

/** Every core route's method handlers, resolving each request with `contextFor`. */
export function coreRoutes(contextFor: ContextFor, env: RouteEnv): CoreRoutes {
  return Object.freeze(
    Object.fromEntries(
      (Object.keys(ROUTE_MODULES) as RouteName[]).map((name) => [
        name,
        bind(name, contextFor, env),
      ]),
    ),
  ) as CoreRoutes;
}
