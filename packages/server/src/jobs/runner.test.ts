import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@docmyrepos/core";

import { createApp } from "../app/create-app";
import { resetRuntimeRegistry } from "../app/registry";
import type { RequestContext } from "../app/types";
import {
  createJobRunner,
  InvalidJobPayloadError,
  UnknownJobError,
  UnknownJobTenantError,
  type JobHandler,
} from "./runner";

const A: TenantContext = { id: "a", attributes: {} };
const B: TenantContext = { id: "b", attributes: {} };
const CONFIG = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/unused",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};

afterEach(() => resetRuntimeRegistry());

function runnerWith(handler: JobHandler) {
  const contextOf = vi.fn((tenant: TenantContext) => ({ tenant }) as unknown as RequestContext);
  const run = createJobRunner({
    handlers: new Map([["demo.work", handler]]),
    listTenants: async () => [A, B],
    contextOf,
  });
  return { run, contextOf };
}

describe("the job runner", () => {
  it("runs the job for the tenant its payload names", async () => {
    const handler = vi.fn<JobHandler>(async () => undefined);
    const { run } = runnerWith(handler);
    await run({ name: "demo.work", payload: { tenantId: "b", n: 1 } });
    expect(handler).toHaveBeenCalledOnce();
    const [payload, ctx] = handler.mock.calls[0]!;
    expect(payload).toEqual({ tenantId: "b", n: 1 });
    expect(ctx.tenant).toBe(B);
  });

  it("rejects an unknown job by name, and runs nothing", async () => {
    const handler = vi.fn<JobHandler>(async () => undefined);
    const { run, contextOf } = runnerWith(handler);
    const failure = run({ name: "demo.missing", payload: { tenantId: "a" } });
    await expect(failure).rejects.toThrow(UnknownJobError);
    await expect(failure).rejects.toThrow('"demo.missing"');
    expect(handler).not.toHaveBeenCalled();
    expect(contextOf).not.toHaveBeenCalled();
  });

  it("rejects a tenant that is not listed, and runs nothing", async () => {
    const handler = vi.fn<JobHandler>(async () => undefined);
    const { run } = runnerWith(handler);
    for (const payload of [{ tenantId: "c" }, {} as { tenantId: string }]) {
      await expect(run({ name: "demo.work", payload })).rejects.toThrow(UnknownJobTenantError);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("app.jobs.run", () => {
  it("knows the core jobs and refuses others", async () => {
    const app = createApp({ config: CONFIG });
    await expect(
      app.jobs.run({ name: "sync.nope", payload: { tenantId: "default" } }),
    ).rejects.toThrow(UnknownJobError);
  });

  it("refuses an invalid payload before reading the tenant's workspace", async () => {
    const forTenant = vi.fn(async () => {
      throw new Error("must not be reached");
    });
    const app = createApp({ config: CONFIG, adapters: { database: { forTenant } } });
    await expect(
      app.jobs.run({ name: "sync.full", payload: { tenantId: "default", trigger: "manual" } }),
    ).rejects.toThrow(InvalidJobPayloadError);
    await expect(
      app.jobs.run({ name: "sync.repo", payload: { tenantId: "default", githubId: "1" } }),
    ).rejects.toThrow(InvalidJobPayloadError);
    expect(forTenant).not.toHaveBeenCalled();
  });

  it("resolves the tenant from listTenants", async () => {
    const forTenant = vi.fn(async () => {
      throw new Error("tenant database down");
    });
    const app = createApp({
      config: CONFIG,
      hooks: { listTenants: () => [A, B] },
      adapters: { database: { forTenant } },
    });
    await expect(app.jobs.run({ name: "sync.drain", payload: { tenantId: "b" } })).rejects.toThrow(
      "tenant database down",
    );
    expect(forTenant).toHaveBeenCalledWith(B);
    await expect(
      app.jobs.run({ name: "sync.drain", payload: { tenantId: "default" } }),
    ).rejects.toThrow(UnknownJobTenantError);
  });

  it("is what the default jobs adapter runs, in process, returning its completion", async () => {
    const forTenant = vi.fn(async () => {
      throw new Error("tenant database down");
    });
    const app = createApp({ config: CONFIG, adapters: { database: { forTenant } } });
    const { done } = await app.adapters.jobs.submit({
      name: "sync.reap",
      payload: { tenantId: "default" },
    });
    await expect(done).rejects.toThrow("tenant database down");
  });
});
