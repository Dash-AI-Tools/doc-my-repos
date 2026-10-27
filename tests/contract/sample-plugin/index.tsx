import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import { EXTENSION_API_VERSION, definePlugin } from "@docmyrepos/core";
import type { Plugin } from "@docmyrepos/server";

/**
 * A sample plugin, written against the public API only: what a host app's own plugin looks like.
 * It has a private and a public route, a private and a public page, a job run every minute for
 * every tenant, a migration into its own schema, and one contribution to each UI slot.
 */
export const samplePlugin: Plugin = definePlugin<Plugin>({
  id: "sample",
  apiVersion: EXTENSION_API_VERSION,
  routes: [
    {
      method: "GET",
      path: "usage",
      handler: async (_request, ctx) => {
        const { rows } = await (
          await ctx.db()
        ).execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_sample.ticks`);
        return Response.json({ tenant: ctx.tenant.id, ticks: rows[0]?.n ?? 0 });
      },
    },
    {
      method: "POST",
      path: "usage",
      handler: async (_request, ctx) => {
        await ctx.adapters.jobs.submit({
          name: "sample.tick",
          payload: { tenantId: ctx.tenant.id },
        });
        return Response.json({ queued: true }, { status: 202 });
      },
    },
    {
      method: "GET",
      path: "public/ping",
      public: true,
      handler: async (_request, ctx) => Response.json({ pong: ctx.tenant.id }),
    },
    {
      method: "POST",
      path: "public/hook",
      public: true,
      // A machine endpoint: the handler authenticates the caller itself.
      machine: true,
      handler: async (request) =>
        request.headers.get("x-sample-key") === "sample-hook-key"
          ? new Response(null, { status: 204 })
          : Response.json({ error: "unauthorized" }, { status: 401 }),
    },
  ],
  pages: [
    {
      path: "account",
      title: "Sample account",
      render: async (ctx) => <p>Signed in to tenant {ctx.tenant.id}.</p>,
    },
    {
      path: "public/about",
      public: true,
      title: "About the sample",
      render: async () => <p>A sample plugin.</p>,
    },
  ],
  jobs: [
    {
      name: "sample.tick",
      handler: async (payload, ctx) => {
        await (
          await ctx.db()
        ).execute(sql`INSERT INTO plugin_sample.ticks (tenant_id) VALUES (${ctx.tenant.id})`);
      },
    },
  ],
  schedules: [{ job: "sample.tick", everyMs: 60_000 }],
  migrations: { folder: fileURLToPath(new URL("./migrations", import.meta.url)) },
  slots: {
    "header.nav": () => ({ href: "/-/sample/account", label: "Sample" }),
    "account.menu": () => ({
      href: "/-/sample/account",
      label: "Sample settings",
      adminOnly: true,
    }),
    "admin.sections": () => ({
      href: "/-/sample/account",
      label: "Sample",
      description: "What the sample plugin keeps.",
    }),
    "admin.workspace.tabs": () => ({
      id: "sample",
      label: "Sample",
      render: async (ctx) => <p>Sample settings of {ctx.tenant.id}.</p>,
    }),
    // Shown to one tenant only: contributions are evaluated per request.
    "layout.banner": (ctx) =>
      ctx.tenant.id === "b" ? { render: async () => <p role="status">Trial ends soon.</p> } : null,
    "footer.links": () => ({ href: "/-/sample/public/about", label: "About the sample" }),
  },
});
