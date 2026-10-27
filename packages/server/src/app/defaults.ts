import {
  DEFAULT_TENANT,
  defaultAuthorize,
  isDefaultTenant,
  type TenantContext,
} from "@docmyrepos/core";

import { sessionUser } from "../auth/authenticate";
import { columnLogoStore, LOGO_BLOB } from "../branding";
import { ConfigError } from "../config/errors";
import { getDb } from "../db/client";
import type { StartupConfig } from "./config";
import { webhookTasks } from "../webhooks/service";
import type { Adapters, Hooks, Job, JobRunOptions } from "./types";

/**
 * The open-source behavior of every hook, bound to an app's configuration and adapters (the
 * session secret and the tenant's database). `createApp` uses it for every hook it is not given,
 * and exposes the result as `app.defaults.hooks`, so a host hook can fall back to the default:
 *
 *   authenticate: async (request, tenant) =>
 *     (await ssoUser(request)) ?? app.defaults.hooks.authenticate(request, tenant),
 */
export function createDefaultHooks(config: StartupConfig, adapters: Adapters): Hooks {
  // As read before the app existed: the trimmed value, valid or not (startup reports problems).
  const sessionSecret = config.source.SESSION_SECRET?.trim() ?? "";
  return Object.freeze<Hooks>({
    resolveTenant: () => DEFAULT_TENANT,
    listTenants: () => [DEFAULT_TENANT],
    authenticate: async (request, tenant) =>
      sessionUser(request, tenant, {
        db: async () => (await adapters.database.forTenant(tenant)).db,
        sessionSecret,
        env: config.source,
      }),
    authorize: async (ctx, action, resource) =>
      defaultAuthorize(await ctx.user(), action, resource),
    checkEntitlement: () => true,
    onEvent: () => undefined,
  });
}

/** Rejected by the default email adapter: the open-source core sends no mail. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email is not configured: this app has no email adapter");
    this.name = "EmailNotConfiguredError";
  }
}

/** Rejected by the default blob store for any name but the ones the core stores. */
export class UnsupportedBlobError extends Error {
  constructor(name: string) {
    super(`The default blob store does not store "${name}"`);
    this.name = "UnsupportedBlobError";
  }
}

/** What the defaults use of the app they end up in. */
export interface ComposedApp {
  /** The app's adapters, so a default that stores data uses the app's database adapter. */
  readonly adapters: () => Adapters;
  /** `app.jobs.run`, which the in-process jobs adapter calls. */
  readonly runJob: (job: Job, options?: JobRunOptions) => Promise<void>;
}

/** Rejected by the default jobs adapter of defaults made without an app. */
export class JobsNotAvailableError extends Error {
  constructor() {
    super("Jobs run only in an application made by createApp");
    this.name = "JobsNotAvailableError";
  }
}

/**
 * The open-source infrastructure, bound to the startup configuration and, through `app`, to the
 * application they are part of.
 */
export function defaultAdapters(config: StartupConfig, app?: ComposedApp): Adapters {
  const logo = (tenant: TenantContext, name: string) => {
    if (name !== LOGO_BLOB) throw new UnsupportedBlobError(name);
    const database = (app?.adapters() ?? adapters).database;
    return columnLogoStore(async () => (await database.forTenant(tenant)).db);
  };
  const adapters: Adapters = Object.freeze({
    database: {
      // The one database at DATABASE_URL, for the built-in tenant only.
      async forTenant(tenant) {
        if (!isDefaultTenant(tenant)) {
          throw new ConfigError([
            `tenant "${tenant.id}": the default database adapter serves only the built-in tenant`,
          ]);
        }
        return getDb(config.source);
      },
    },
    secrets: {
      // The startup configuration's key, for every tenant.
      async encryptionKey() {
        return config.encryptionKey;
      },
    },
    blobs: {
      // `branding/logo` in the `site_branding` row, where logos have always been stored.
      get: async (tenant, name) => logo(tenant, name).get(),
      put: async (tenant, name, blob) => logo(tenant, name).put(blob),
      delete: async (tenant, name) => logo(tenant, name).delete(),
    },
    email: {
      async send() {
        throw new EmailNotConfiguredError();
      },
    },
    jobs: {
      // Runs each job in this process at once, tracked with the other background work.
      async submit(job, options) {
        if (app === undefined) throw new JobsNotAvailableError();
        const done = app.runJob(job, options);
        webhookTasks().detach(done);
        return { done };
      },
    },
  } satisfies Adapters);
  return adapters;
}
