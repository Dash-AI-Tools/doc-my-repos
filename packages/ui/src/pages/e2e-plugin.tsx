import { EXTENSION_API_VERSION } from "@docmyrepos/core";
import type { Plugin } from "@docmyrepos/server";

/**
 * A FIXTURE PLUGIN for the e2e suite, not a product feature: one private and one public page, so
 * `e2e/plugin-pages.spec.ts` can check plugin pages render inside the site layout. The app module
 * registers it only when `E2E_FIXTURES=1` (see `packages/core/src/e2e-fixtures.ts`).
 */
export const e2eFixturePlugin: Plugin = {
  id: "fixture",
  apiVersion: EXTENSION_API_VERSION,
  pages: [
    {
      path: "hello",
      title: "Fixture plugin",
      render: async (ctx) => (
        <article className="space-y-3">
          <h1 className="text-2xl font-semibold text-foreground">Hello from a plugin</h1>
          <p className="text-muted-foreground" data-testid="fixture-tenant">
            Rendered for tenant {ctx.tenant.id}.
          </p>
        </article>
      ),
    },
    {
      path: "public/hi",
      public: true,
      title: "Fixture plugin, public",
      render: async () => (
        <article className="space-y-3">
          <h1 className="text-2xl font-semibold text-foreground">Hi, signed out or not</h1>
        </article>
      ),
    },
  ],
};
