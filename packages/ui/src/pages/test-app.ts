import { DEFAULT_TENANT, WORKSPACE, defaultAuthorize, type User } from "@docmyrepos/core";
import type { App, RequestContext } from "@docmyrepos/server";
import { resolveSlot } from "@docmyrepos/server/internal/plugins/slots";

/** The signed-in user of `testApp()` unless a test passes its own `user`. */
export const TEST_USER = { id: 1, email: "admin@example.com", role: "admin" } as const;

/**
 * For page tests: an app whose `pageContext()` is the built-in tenant with a stand-in database
 * and a signed-in admin. Pages pass `ctx.db` to their (mocked) loaders; `db` resolves to
 * `database`.
 */
export function testApp(database: unknown = {}, overrides: Partial<RequestContext> = {}): App {
  const ctx = {
    tenant: DEFAULT_TENANT,
    db: async () => database,
    user: async () => TEST_USER,
    // The open-source rules over this context's user, unless a test passes its own `can`.
    can: async (action: Parameters<RequestContext["can"]>[0], resource = WORKSPACE) =>
      defaultAuthorize((await ctx.user()) as User | null, action, resource),
    ...overrides,
  } as unknown as RequestContext;
  return {
    pageContext: async () => ctx,
    context: async () => ctx,
    // The core's slot items and no plugins.
    slots: {
      resolve: (slot, slotCtx, state) => resolveSlot({ plugins: [] }, slot, slotCtx, state),
    },
  } as Pick<App, "slots"> as unknown as App;
}

/** An app whose requests match no tenant. */
export function unknownTenantApp(): App {
  return { pageContext: async () => null, context: async () => null } as unknown as App;
}
