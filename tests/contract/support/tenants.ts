import pg from "pg";

import type { TenantContext } from "@docmyrepos/core";
import { createApp, createDb, type CreateAppOptions, type DbHandle } from "@docmyrepos/server";

import { HOST_CONFIG } from "../host";
import { createContractDatabase, type ContractDatabase } from "./database";

/**
 * Two tenants, `a` and `b`, each with its own database, behind one host app that resolves the
 * tenant from the `x-tenant` header. Tests pass the hooks and adapters they exercise.
 */
export interface TwoTenants {
  readonly databases: Readonly<Record<"a" | "b", ContractDatabase>>;
  /** A host app over the two databases, with `options` added (`config` adds to the host's). */
  app(
    options?: Omit<CreateAppOptions, "config"> & {
      readonly config?: Readonly<Record<string, string>>;
    },
  ): ReturnType<typeof createApp>;
  /** A request for `path`, resolved to `tenant` (null: no tenant). */
  request(path: string, tenant: string | null, init?: RequestInit): Request;
  /** Runs SQL against a tenant's database. */
  sql<T extends pg.QueryResultRow>(
    tenant: "a" | "b",
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

export const TENANTS: Readonly<Record<string, TenantContext>> = {
  a: { id: "a", attributes: {} },
  b: { id: "b", attributes: {} },
};

export const ORIGIN = "http://docs.example.com";

export async function twoTenants(): Promise<TwoTenants> {
  const [a, b] = await Promise.all([createContractDatabase(), createContractDatabase()]);
  const databases = { a, b };
  const handles = new Map<string, DbHandle>();
  const database = {
    async forTenant(tenant: TenantContext) {
      let handle = handles.get(tenant.id);
      if (!handle) {
        // The default pool size: a scheduled sync holds several connections at once (its lock,
        // the run's and the repository's).
        handle = createDb(databases[tenant.id as "a" | "b"].url);
        handles.set(tenant.id, handle);
      }
      return handle;
    },
  };
  return {
    databases,
    app: (options = {}) =>
      createApp({
        ...options,
        config: {
          ...HOST_CONFIG,
          DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
          ...options.config,
        },
        hooks: {
          resolveTenant: (request) => TENANTS[request.headers.get("x-tenant") ?? ""] ?? null,
          listTenants: () => Object.values(TENANTS),
          ...options.hooks,
        },
        adapters: { database, ...options.adapters },
      }),
    request: (path, tenant, init = {}) => {
      const headers = new Headers(init.headers);
      if (tenant !== null) headers.set("x-tenant", tenant);
      return new Request(`${ORIGIN}${path}`, { ...init, headers });
    },
    sql: async (tenant, text, values = []) => {
      const client = new pg.Client({ connectionString: databases[tenant].url });
      await client.connect();
      try {
        return (await client.query(text, values)).rows;
      } finally {
        await client.end();
      }
    },
    close: async () => {
      for (const handle of handles.values()) await handle.close();
      await Promise.all([a.drop(), b.drop()]);
    },
  };
}
