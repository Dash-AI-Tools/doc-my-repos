import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TENANT, EXTENSION_API_VERSION, type User } from "@docmyrepos/core";

import { parseEnv } from "../config/env";
import { loadConfig } from "./config";
import { CompositionError, createApp } from "./create-app";
import { EmailNotConfiguredError, createDefaultHooks, defaultAdapters } from "./defaults";
import { resetRuntimeRegistry } from "./registry";
import type { Plugin, RequestContext } from "./types";

const ENV = {
  DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const plugin = (id: string, extra: Partial<Plugin> = {}): Plugin => ({
  id,
  apiVersion: EXTENSION_API_VERSION,
  ...extra,
});

afterEach(() => {
  resetRuntimeRegistry();
});

/** The messages `createApp` throws for `options`, or [] when it does not throw. */
function problems(options: Parameters<typeof createApp>[0]): readonly string[] {
  try {
    createApp(options);
    return [];
  } catch (error) {
    if (error instanceof CompositionError) return error.problems;
    throw error;
  }
}

describe("createApp", () => {
  it("uses every default when given nothing", () => {
    const app = createApp({ config: ENV });
    expect(app.apiVersion).toBe(EXTENSION_API_VERSION);
    expect(Object.keys(app.hooks).sort()).toEqual(Object.keys(app.defaults.hooks).sort());
    for (const name of Object.keys(app.hooks) as (keyof typeof app.hooks)[]) {
      expect(app.hooks[name], name).toBe(app.defaults.hooks[name]);
    }
    expect(Object.keys(app.adapters).sort()).toEqual([
      "blobs",
      "database",
      "email",
      "jobs",
      "secrets",
    ]);
    expect(app.plugins).toEqual([]);
    expect(app.config.problems).toEqual([]);
  });

  it("replaces only the hooks it is given", () => {
    const onEvent = () => undefined;
    const app = createApp({ config: ENV, hooks: { onEvent } });
    expect(app.hooks.onEvent).toBe(onEvent);
    expect(app.hooks.authorize).toBe(app.defaults.hooks.authorize);
    expect(app.hooks.resolveTenant).toBe(app.defaults.hooks.resolveTenant);
  });

  it("names a duplicate plugin id", () => {
    expect(problems({ config: ENV, plugins: [plugin("metering"), plugin("metering")] })).toEqual([
      'plugin id "metering" is used twice',
    ]);
  });

  it("names a plugin for another API major version, with both versions", () => {
    expect(problems({ config: ENV, plugins: [plugin("metering", { apiVersion: 2 })] })).toEqual([
      'plugin "metering" targets extension API 2; this core supports 1',
    ]);
  });

  it("refuses invalid plugin ids and job names", () => {
    expect(
      problems({
        config: ENV,
        plugins: [
          plugin("Metering"),
          plugin("billing", { jobs: [{ name: "sync.full", handler: async () => {} }] }),
        ],
      }),
    ).toEqual([
      'plugin id "Metering" is not a lowercase slug',
      'job "sync.full" must be named "billing.<name>"',
    ]);
  });

  it("refuses a plugin job named like a core job", () => {
    expect(
      problems({
        plugins: [plugin("sync", { jobs: [{ name: "sync.full", handler: async () => {} }] })],
      }),
    ).toEqual(['job "sync.full" is a core job']);
  });

  it("changes nothing with a minimal plugin, and runs a plugin's job for its tenant", async () => {
    const bare = createApp({ config: ENV });
    const seen: string[] = [];
    const app = createApp({
      config: ENV,
      plugins: [
        plugin("minimal"),
        plugin("metering", {
          jobs: [
            {
              name: "metering.report",
              handler: async (payload, ctx) =>
                void seen.push(`${ctx.tenant.id}:${JSON.stringify(payload)}`),
            },
          ],
        }),
      ],
    });
    expect(Object.keys(app.routes)).toEqual(Object.keys(bare.routes));
    expect(Object.keys(app.hooks)).toEqual(Object.keys(bare.hooks));
    expect(Object.keys(app.adapters)).toEqual(Object.keys(bare.adapters));
    expect(app.plugins.map((p) => p.id)).toEqual(["minimal", "metering"]);
    await app.jobs.run({ name: "metering.report", payload: { tenantId: "default", n: 1 } });
    expect(seen).toEqual(['default:{"tenantId":"default","n":1}']);
  });

  it("refuses hooks that are not functions, unknown hooks and incomplete adapters", () => {
    expect(
      problems({
        config: ENV,
        hooks: { authorize: true, authorise: () => true } as never,
        adapters: { email: {}, queue: {} } as never,
      }),
    ).toEqual([
      "hooks.authorize is not a function",
      "hooks.authorise is not a hook",
      "adapters.email.send is not a function",
      "adapters.queue is not an adapter",
    ]);
  });

  it("never puts a configuration value in an error", () => {
    try {
      createApp({ config: ENV, hooks: { authorize: ENV.SESSION_SECRET } as never });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(ENV.SESSION_SECRET);
    }
  });

  it("shares one process registry between apps", () => {
    const a = createApp({ config: ENV });
    const b = createApp({ config: ENV, hooks: { onEvent: () => undefined } });
    expect(a.runtime).toBe(b.runtime);
  });
});

describe("loadConfig", () => {
  const cases: Record<string, Record<string, string | undefined>> = {
    valid: ENV,
    "placeholder session secret": { ...ENV, SESSION_SECRET: "replace-with-session-secret" },
    "short sync secret": { ...ENV, SYNC_SECRET: "short" },
    "missing database": { ...ENV, DATABASE_URL: undefined },
    "half a bootstrap admin": { ...ENV, ADMIN_EMAIL: "admin@example.com" },
    "bad log level": { ...ENV, LOG_LEVEL: "loud" },
    empty: {},
  };

  for (const [name, env] of Object.entries(cases)) {
    it(`reports the same problems as parseEnv: ${name}`, () => {
      expect(loadConfig(env).problems).toEqual(parseEnv(env).problems);
    });
  }

  it("reads the encryption key, retired settings and scheduler mode from the given source", () => {
    const config = loadConfig({
      ...ENV,
      SETTINGS_ENCRYPTION_KEY: "",
      GITHUB_APP_ID: "1",
      SYNC_SCHEDULER: "1",
    });
    expect(config.encryptionKey).toEqual({
      key: null,
      problem: "SETTINGS_ENCRYPTION_KEY: is not set",
    });
    expect(config.retired).toContain("GITHUB_APP_ID");
    expect(config.scheduler).toMatchObject({ enabled: true, reason: "forced_on" });
  });

  it("prints as [redacted]", () => {
    const config = loadConfig(ENV);
    expect(JSON.stringify(config)).toBe('"[redacted]"');
    expect(String(config)).toBe("[redacted]");
  });
});

describe("default adapters", () => {
  it("serve the configured database only to the built-in tenant", async () => {
    const app = createApp({ config: ENV });
    await expect(app.adapters.database.forTenant({ id: "acme", attributes: {} })).rejects.toThrow(
      'tenant "acme": the default database adapter serves only the built-in tenant',
    );
  });

  it("give every tenant the key from SETTINGS_ENCRYPTION_KEY", async () => {
    const app = createApp({ config: ENV });
    const a = await app.adapters.secrets.encryptionKey(DEFAULT_TENANT);
    const b = await app.adapters.secrets.encryptionKey({ id: "acme", attributes: {} });
    expect(a.key).not.toBeNull();
    expect(b).toBe(a);
  });

  it("refuse to send email", async () => {
    const app = createApp({ config: ENV });
    await expect(
      app.adapters.email.send(DEFAULT_TENANT, { to: "a@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow(EmailNotConfiguredError);
  });

  it("hands the request context the app's blob store and email adapter", async () => {
    const send = async () => undefined;
    const host = createApp({ config: ENV, adapters: { email: { send } } });
    const ctx = await host.context(new Request("http://localhost/"));
    expect(ctx?.adapters.email.send).toBe(send);
    expect(ctx?.adapters.blobs).toBe(host.adapters.blobs);
    const plain = await createApp({ config: ENV }).context(new Request("http://localhost/"));
    await expect(
      plain!.adapters.email.send(plain!.tenant, { to: "a@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow(EmailNotConfiguredError);
  });
});

describe("default hooks", () => {
  const config = loadConfig(ENV);
  const defaultHooks = createDefaultHooks(config, defaultAdapters(config));

  it("resolve and list the built-in tenant and allow every feature", async () => {
    expect(await defaultHooks.resolveTenant(new Request("http://localhost/"))).toBe(DEFAULT_TENANT);
    expect(await defaultHooks.listTenants()).toEqual([DEFAULT_TENANT]);
    expect(await defaultHooks.checkEntitlement({} as RequestContext, "ask")).toBe(true);
  });

  it("authorize with the open-source rules for the context's user", async () => {
    const as = (user: User | null) => ({ user: async () => user }) as RequestContext;
    const admin: User = { id: 1, email: "a@example.com", role: "admin" };
    const member: User = { id: 2, email: "m@example.com", role: "user" };
    const workspace = { kind: "workspace" } as const;
    expect(await defaultHooks.authorize(as(admin), "admin.manage", workspace)).toBe(true);
    expect(await defaultHooks.authorize(as(member), "admin.manage", workspace)).toBe(false);
    expect(await defaultHooks.authorize(as(null), "content.read", workspace)).toBe(false);
  });
});
