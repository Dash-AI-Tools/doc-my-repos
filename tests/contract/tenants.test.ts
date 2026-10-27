import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, createDb, type DbHandle } from "@docmyrepos/server";
import type { TenantContext } from "@docmyrepos/core";

import { HOST_CONFIG } from "./host";
import { createContractDatabase, type ContractDatabase } from "./support/database";
import { seedRepository } from "./support/seed";

/**
 * Two tenants, each with its own database, behind one application: the host resolves the tenant
 * from a request header and hands each tenant its database. Every read sees only its own tenant.
 */
let databases: Record<"a" | "b", ContractDatabase>;
const handles = new Map<string, DbHandle>();

beforeAll(async () => {
  const [a, b] = await Promise.all([createContractDatabase(), createContractDatabase()]);
  databases = { a, b };
  await seedRepository(a.url, { githubId: 1001, owner: "alpha", name: "handbook" }, [
    { path: "docs/onboarding.md", title: "Onboarding", body: "Alpha onboarding guide for kayaks." },
  ]);
  await seedRepository(b.url, { githubId: 2002, owner: "beta", name: "runbooks" }, [
    { path: "docs/oncall.md", title: "On call", body: "Beta on-call runbook for kayaks." },
  ]);
}, 60_000);

afterAll(async () => {
  for (const handle of handles.values()) await handle.close();
  await Promise.all([databases?.a.drop(), databases?.b.drop()]);
});

const TENANTS: Record<string, TenantContext> = {
  a: { id: "a", attributes: {} },
  b: { id: "b", attributes: {} },
};

const app = createApp({
  config: { ...HOST_CONFIG, DATABASE_URL: "postgres://unused@127.0.0.1:1/unused" },
  hooks: {
    resolveTenant: (request) => TENANTS[request.headers.get("x-tenant") ?? ""] ?? null,
    listTenants: () => Object.values(TENANTS),
    authenticate: async () => ({ id: 1, email: "reader@example.com", role: "user" }),
  },
  adapters: {
    database: {
      async forTenant(tenant) {
        const existing = handles.get(tenant.id);
        if (existing) return existing;
        const handle = createDb(databases[tenant.id as "a" | "b"].url, { max: 3 });
        handles.set(tenant.id, handle);
        return handle;
      },
    },
  },
});

const get = (path: string, tenant: string | null) =>
  new Request(`http://docs.example.com${path}`, {
    headers: tenant === null ? {} : { "x-tenant": tenant },
  });

describe("one application, a database per tenant", () => {
  it("searches only the request's tenant", async () => {
    const a = await (await app.routes.search.GET(get("/api/search?q=kayaks", "a"))).json();
    const b = await (await app.routes.search.GET(get("/api/search?q=kayaks", "b"))).json();
    expect(a.hits.map((h: { title: string }) => h.title)).toEqual(["Onboarding"]);
    expect(b.hits.map((h: { title: string }) => h.title)).toEqual(["On call"]);
    expect(a.hits[0].href).toMatch(/^\/alpha\/handbook/);
    expect(b.hits[0].href).toMatch(/^\/beta\/runbooks/);
  });

  it("lists only the request's tenant's repositories", async () => {
    const a = await (await app.routes.status.GET(get("/api/status", "a"))).json();
    const b = await (await app.routes.status.GET(get("/api/status", "b"))).json();
    const names = (body: { repos: { owner: string; name: string }[] }) =>
      body.repos.map((r) => `${r.owner}/${r.name}`);
    expect(names(a)).toEqual(["alpha/handbook"]);
    expect(names(b)).toEqual(["beta/runbooks"]);
  });

  it("answers a request that matches no tenant with a generic 404 and opens no database", async () => {
    const opened = handles.size;
    const response = await app.routes.search.GET(get("/api/search?q=kayaks", null));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found\n");
    expect(handles.size).toBe(opened);
  });

  it("gives each request a context with its tenant and that tenant's database", async () => {
    const ctx = await app.context(get("/", "b"));
    expect(ctx?.tenant.id).toBe("b");
    const rows = await (await ctx!.dbHandle()).pool.query("select owner from repos");
    expect(rows.rows).toEqual([{ owner: "beta" }]);
    expect(await app.context(get("/", "c"))).toBeNull();
  });
});
