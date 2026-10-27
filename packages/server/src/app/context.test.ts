import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TENANT, type TenantContext } from "@docmyrepos/core";

import { recordingLogger } from "../test-logger";
import { loadConfig } from "./config";
import { createContext, requestFromHeaders, resolveTenant } from "./context";
import { createDefaultHooks, defaultAdapters } from "./defaults";
import type { Adapters, Hooks } from "./types";

const ENV = {
  DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};
const ACME: TenantContext = { id: "acme", attributes: {} };
const request = () => new Request("http://localhost/acme");

function deps(hooks: Partial<Hooks> = {}, adapters: Partial<Adapters> = {}) {
  const recorder = recordingLogger();
  const config = loadConfig(ENV);
  const allAdapters = { ...defaultAdapters(config), ...adapters };
  return {
    recorder,
    deps: {
      hooks: { ...createDefaultHooks(config, allAdapters), ...hooks },
      adapters: allAdapters,
      log: recorder.log,
    },
  };
}

describe("resolveTenant", () => {
  it("returns the built-in tenant by default", async () => {
    expect(await resolveTenant(deps().deps, request())).toBe(DEFAULT_TENANT);
  });

  it("returns null, and opens no database, when the hook finds no tenant", async () => {
    const forTenant = vi.fn();
    const { deps: d } = deps({ resolveTenant: () => null }, { database: { forTenant } });
    expect(await resolveTenant(d, request())).toBeNull();
    expect(forTenant).not.toHaveBeenCalled();
  });

  it("fails closed and names the hook when it throws", async () => {
    const { deps: d, recorder } = deps({
      resolveTenant: () => {
        throw new TypeError("token=abc boom");
      },
    });
    expect(await resolveTenant(d, request())).toBeNull();
    expect(recorder.find("hook.failed")).toMatchObject([{ hook: "resolveTenant" }]);
    expect(recorder.lines.join("")).not.toContain("token=abc");
  });
});

describe("createContext", () => {
  it("logs the built-in tenant's lines unchanged, and names any other tenant", () => {
    const { deps: d, recorder } = deps();
    createContext(d, DEFAULT_TENANT, request()).log.info("probe.event", { n: 1 });
    d.log.info("probe.event", { n: 1 });
    createContext(d, ACME, request()).log.info("probe.event", { n: 1 });
    const [own, plain, other] = recorder.records;
    const strip = (record: Record<string, unknown>) => {
      const rest = { ...record };
      delete rest.ts;
      return rest;
    };
    expect(strip(own as Record<string, unknown>)).toEqual(strip(plain as Record<string, unknown>));
    expect(own).not.toHaveProperty("tenant");
    expect(other).toMatchObject({ event: "probe.event", tenant: "acme" });
  });

  it("asks the database adapter once, for its tenant", async () => {
    const handle = { db: {} } as never;
    const forTenant = vi.fn(async () => handle);
    const { deps: d } = deps({}, { database: { forTenant } });
    const ctx = createContext(d, ACME, request());
    await Promise.all([ctx.db(), ctx.db(), ctx.dbHandle()]);
    expect(forTenant).toHaveBeenCalledTimes(1);
    expect(forTenant).toHaveBeenCalledWith(ACME);
  });

  it("surfaces the default adapter's refusal of another tenant", async () => {
    const { deps: d } = deps();
    await expect(createContext(d, ACME, request()).db()).rejects.toThrow(
      'tenant "acme": the default database adapter serves only the built-in tenant',
    );
  });

  it("authenticates once per request, and never for a job", async () => {
    const user = { id: 7, email: "u@example.com", role: "user" as const };
    const authenticate = vi.fn(async () => user);
    const { deps: d } = deps({ authenticate });
    const ctx = createContext(d, DEFAULT_TENANT, request());
    expect(await ctx.user()).toBe(user);
    await ctx.user();
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(await createContext(d, DEFAULT_TENANT, null).user()).toBeNull();
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("counts as signed out, and names the hook, when authenticate throws", async () => {
    const { deps: d, recorder } = deps({
      authenticate: async () => {
        throw new Error("identity provider down");
      },
    });
    expect(await createContext(d, DEFAULT_TENANT, request()).user()).toBeNull();
    expect(recorder.find("hook.failed")).toMatchObject([{ hook: "authenticate" }]);
  });

  it("denies when authorize or checkEntitlement throws", async () => {
    const { deps: d, recorder } = deps({
      authorize: () => {
        throw new Error("x");
      },
      checkEntitlement: async () => {
        throw new Error("y");
      },
    });
    const ctx = createContext(d, DEFAULT_TENANT, request());
    expect(await ctx.can("admin.manage")).toBe(false);
    expect(await ctx.entitled("ask")).toBe(false);
    expect(recorder.find("hook.failed").map((r) => r.hook)).toEqual([
      "authorize",
      "checkEntitlement",
    ]);
  });

  it("never waits for an onEvent that hangs", () => {
    const { deps: d } = deps({ onEvent: () => new Promise<void>(() => undefined) });
    const ctx = createContext(d, DEFAULT_TENANT, request());
    const started = Date.now();
    for (let i = 0; i < 100; i++) ctx.emit({ name: "auth.logout", payload: { userId: 1 } });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("delivers events after the fact, stamped, and survives a failing hook", async () => {
    const seen: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps: d, recorder } = deps({
      onEvent: async (event) => {
        seen.push(event);
        await gate;
        throw new Error("down");
      },
    });
    const ctx = createContext(d, ACME, request());
    ctx.emit({ name: "auth.logout", payload: { userId: 3 }, actorId: 3 });
    expect(seen).toEqual([]);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      name: "auth.logout",
      schemaVersion: 1,
      tenantId: "acme",
      actorId: 3,
      payload: { userId: 3 },
    });
    release();
    await vi.waitFor(() => expect(recorder.find("hook.failed")).toHaveLength(1));
    expect(recorder.find("hook.failed")[0]).toMatchObject({
      hook: "onEvent",
      eventName: "auth.logout",
    });
  });
});

describe("requestFromHeaders", () => {
  it("rebuilds the URL from the host, the forwarded protocol and the proxy's path header", () => {
    const request = requestFromHeaders(
      new Headers({
        host: "docs.example.com",
        "x-forwarded-proto": "https, http",
        "x-dmr-pathname": "/acme/handbook/docs/guide",
        cookie: "dmr_session=abc",
      }),
    );
    expect(request.url).toBe("https://docs.example.com/acme/handbook/docs/guide");
    expect(request.headers.get("cookie")).toBe("dmr_session=abc");
  });

  it("falls back to the root path and localhost when the headers are missing or unusable", () => {
    expect(requestFromHeaders(new Headers()).url).toBe("http://localhost/");
    expect(
      requestFromHeaders(new Headers({ host: "bad host", "x-dmr-pathname": "//evil.example" })).url,
    ).toBe("http://localhost//evil.example");
    // A path that looks like a protocol-relative URL never changes the host.
    expect(
      requestFromHeaders(
        new Headers({ host: "docs.example.com", "x-dmr-pathname": "//evil.example/x" }),
      ).url,
    ).toBe("http://docs.example.com//evil.example/x");
    expect(requestFromHeaders(new Headers({ "x-dmr-pathname": "relative" })).url).toBe(
      "http://localhost/",
    );
  });
});
