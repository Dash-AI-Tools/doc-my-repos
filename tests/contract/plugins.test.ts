import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXTENSION_API_VERSION } from "@docmyrepos/core";
import type { Job, Plugin } from "@docmyrepos/server";
import { migrateDatabase } from "@docmyrepos/server/migrate";

import { samplePlugin } from "./sample-plugin";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * The sample plugin extends a host app through the public API alone: its routes, pages, job,
 * schedule, migration and slot contributions each work for the tenant of the request or job.
 */
const broken: Plugin = {
  id: "broken",
  apiVersion: EXTENSION_API_VERSION,
  slots: {
    "header.nav": () => {
      throw new Error("contribution failed");
    },
  },
};

let t: TwoTenants;
let host: ReturnType<TwoTenants["app"]>;
const queue: Job[] = [];
const users: Record<string, { id: number; email: string; role: "admin" | "user" }> = {
  a: { id: 1, email: "ana@a.example", role: "admin" },
  b: { id: 1, email: "bo@b.example", role: "user" },
};

beforeAll(async () => {
  t = await twoTenants();
  for (const tenant of ["a", "b"] as const) {
    const result = await migrateDatabase(t.databases[tenant].url, { plugins: [samplePlugin] });
    expect(result.plugins).toEqual({ sample: { applied: 1, total: 1 } });
  }
  host = t.app({
    config: { SYNC_SCHEDULER: "1" },
    plugins: [samplePlugin, broken],
    hooks: {
      authenticate: async (request, tenant) =>
        request.headers.get("x-user") === "yes" ? users[tenant.id]! : null,
    },
    adapters: {
      jobs: {
        submit: async (job) => {
          queue.push(job);
          return {};
        },
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const call = (
  method: string,
  path: string,
  tenant: string,
  headers: Record<string, string> = {},
) => {
  const [plugin, ...rest] = path.split("/");
  return host.pluginRoutes[method]!(
    t.request(`/api/plugins/${path}`, tenant, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: "{}" }),
    }),
    { params: Promise.resolve({ plugin: plugin!, path: rest }) },
  );
};
const signedIn = { "x-user": "yes" };
const sameOrigin = { ...signedIn, origin: ORIGIN, "content-type": "application/json" };

describe("the sample plugin", () => {
  it("migrates into its own schema once", async () => {
    const again = await migrateDatabase(t.databases.a.url, { plugins: [samplePlugin] });
    expect(again.plugins).toEqual({ sample: { applied: 0, total: 1 } });
  });

  it("serves its private route to a signed-in user of the request's tenant only", async () => {
    expect((await call("GET", "sample/usage", "a")).status).toBe(401);
    const response = await call("GET", "sample/usage", "b", signedIn);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenant: "b", ticks: 0 });
  });

  it("serves its public routes signed out, and refuses a cross-origin POST", async () => {
    expect(await (await call("GET", "sample/public/ping", "a")).json()).toEqual({ pong: "a" });
    expect(
      (await call("POST", "sample/public/hook", "a", { "x-sample-key": "sample-hook-key" })).status,
    ).toBe(204);
    const crossOrigin = await call("POST", "sample/usage", "a", {
      ...sameOrigin,
      origin: "https://evil.example",
    });
    expect(crossOrigin.status).toBe(403);
    expect(queue).toEqual([]);
  });

  it("queues its job from a route, and the job writes to the job's tenant's database", async () => {
    expect((await call("POST", "sample/usage", "a", sameOrigin)).status).toBe(202);
    const jobs = queue.splice(0);
    expect(jobs).toEqual([{ name: "sample.tick", payload: { tenantId: "a" } }]);
    for (const job of jobs) await host.jobs.run(job);
    expect(await (await call("GET", "sample/usage", "a", signedIn)).json()).toEqual({
      tenant: "a",
      ticks: 1,
    });
    expect(await (await call("GET", "sample/usage", "b", signedIn)).json()).toEqual({
      tenant: "b",
      ticks: 0,
    });
  });

  it("renders its pages with the request's context", async () => {
    const ctx = await host.context(t.request("/-/sample/account", "b", { headers: signedIn }));
    const pages = host.plugin("sample")!.pages!;
    const html = async (path: string) =>
      renderToStaticMarkup(
        (await pages
          .find((p) => p.path === path)!
          .render(ctx!, { rest: [], searchParams: {} })) as ReactElement,
      );
    expect(await html("account")).toBe("<p>Signed in to tenant b.</p>");
    expect(await html("public/about")).toBe("<p>A sample plugin.</p>");
  });

  it("contributes to every slot after the core, and a throwing contribution is left out", async () => {
    const forTenant = async (tenant: "a" | "b") => {
      const ctx = (await host.context(t.request("/", tenant, { headers: signedIn })))!;
      const labels = async (
        slot: "header.nav" | "account.menu" | "admin.sections" | "footer.links",
      ) => (await host.slots.resolve(slot, ctx)).map((item) => item.label);
      return {
        nav: await labels("header.nav"),
        menu: await host.slots.resolve("account.menu", ctx),
        sections: await labels("admin.sections"),
        footer: await labels("footer.links"),
        tabs: (await host.slots.resolve("admin.workspace.tabs", ctx)).map((tab) => tab.id),
        banners: (await host.slots.resolve("layout.banner", ctx)).length,
      };
    };
    const a = await forTenant("a");
    expect(a.nav).toEqual(["Repositories", "Sample"]);
    expect(a.menu.at(-1)).toEqual({
      href: "/-/sample/account",
      label: "Sample settings",
      adminOnly: true,
    });
    expect(a.sections.at(-1)).toBe("Sample");
    expect(a.footer).toEqual(["Sync status", "About the sample"]);
    expect(a.tabs).toEqual(["sample"]);
    // The banner is for tenant b only.
    expect(a.banners).toBe(0);
    expect((await forTenant("b")).banners).toBe(1);
  });

  it("runs its schedule for every tenant", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      await host.start();
      // A tenant whose settings could not be read at boot starts at the next drain tick (a
      // minute), so the clock moves a minute at a time until both tenants have run the job.
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(60_000);
          const tenants = queue
            .filter((job) => job.name === "sample.tick")
            .map((job) => job.payload.tenantId);
          expect(new Set(tenants)).toEqual(new Set(["a", "b"]));
        },
        { timeout: 15_000, interval: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
