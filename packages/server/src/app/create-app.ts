import { cache } from "react";
import { headers } from "next/headers";

import { EXTENSION_API_VERSION, pluginProblems, type SlotName } from "@docmyrepos/core";

import { issueSessionCookie } from "../auth/authenticate";
import type { EnvSource } from "../config/env";
import { CORE_JOBS } from "../jobs/core";
import { createJobRunner } from "../jobs/runner";
import { pluginRouteHandlers, type PluginRouteHandler } from "../plugins/dispatch";
import { createPluginRegistry, registryProblems } from "../plugins/registry";
import { resolveSlot, type CoreSlotState, type ResolvedItems } from "../plugins/slots";
import { coreRoutes, type CoreRoutes } from "../routes/index";
import { loadConfig, type StartupConfig } from "./config";
import { createContext, requestFromHeaders, resolveTenant } from "./context";
import { createDefaultHooks, defaultAdapters } from "./defaults";
import { runtimeRegistry, type RuntimeRegistry } from "./registry";
import { startApp } from "./start";
import {
  ADAPTER_METHODS,
  HOOK_NAMES,
  type AdapterName,
  type Adapters,
  type Hooks,
  type Job,
  type JobRunOptions,
  type Plugin,
  type RequestContext,
} from "./types";

export interface CreateAppOptions {
  /**
   * Startup configuration, with the keys of the environment variables in `.env.example`
   * (`DATABASE_URL`, `SESSION_SECRET`, ...). Validated with the same rules. Default:
   * `process.env`.
   */
  readonly config?: EnvSource;
  /** Hooks to replace; the rest keep their defaults. */
  readonly hooks?: Partial<Hooks>;
  /** Adapters to replace; the rest keep their defaults. */
  readonly adapters?: Partial<Adapters>;
  readonly plugins?: readonly Plugin[];
}

/** The composed application. Route files, the instrumentation and jobs reach the core through it. */
export interface App {
  readonly apiVersion: number;
  readonly config: StartupConfig;
  readonly hooks: Hooks;
  readonly adapters: Adapters;
  readonly plugins: readonly Plugin[];
  /**
   * The open-source hooks and adapters of this app (bound to its configuration), for host hooks
   * and adapters that fall back to a default.
   */
  readonly defaults: { readonly hooks: Hooks; readonly adapters: Adapters };
  /** The process-wide state every app of this process shares. */
  readonly runtime: RuntimeRegistry;
  /**
   * Start-up work for the instrumentation hook: configuration checks and the background
   * scheduler. Never throws; only the first call in a process does anything.
   */
  start(): Promise<void>;
  /**
   * The plugins' API routes, for the catch-all route file
   * `src/app/api/plugins/[plugin]/[...path]/route.ts`: one handler per HTTP method.
   */
  readonly pluginRoutes: Readonly<Record<string, PluginRouteHandler>>;
  /**
   * A UI slot's items for one request: the core's, then the plugins' in order; a contribution that
   * throws is left out. `state` is what the core's items depend on, when the caller has it.
   */
  readonly slots: {
    resolve<S extends SlotName>(
      slot: S,
      ctx: RequestContext,
      state?: CoreSlotState,
    ): Promise<readonly ResolvedItems[S][]>;
  };
  /** The plugin with this id, or undefined. */
  plugin(id: string): Plugin | undefined;
  /**
   * Runs a job by name for the tenant its payload names: what the in-process jobs adapter does,
   * and what a host's queue worker calls. Rejects without running anything for an unknown job
   * name (`UnknownJobError`), a tenant that is not in `listTenants()` or an invalid payload.
   */
  readonly jobs: { run(job: Job, options?: JobRunOptions): Promise<void> };
  /**
   * The core API routes by name, each a set of HTTP method handlers for the route file to export:
   * `export const { GET, POST } = app.routes.search;`.
   */
  readonly routes: CoreRoutes;
  /**
   * The context of a request: its tenant (`resolveTenant`) with that tenant's database, workspace,
   * user, permissions, entitlements and events. Null when the request matches no tenant; the
   * caller answers 404 then, before reading anything.
   */
  context(request: Request): Promise<RequestContext | null>;
  /**
   * `context()` for the request a server component is rendering, built once per request (React
   * `cache`) from the request headers.
   */
  pageContext(): Promise<RequestContext | null>;
  /**
   * Signs user `userId` of the context's tenant in, for a host's own sign-in flow (SSO): returns
   * the `Set-Cookie` header value of a core session, the same a password login issues. `secure`
   * marks the cookie HTTPS-only (default: true).
   */
  issueSession(
    ctx: RequestContext,
    userId: number,
    options?: { readonly secure?: boolean },
  ): Promise<string>;
}

/** `createApp` was given an invalid composition. Names problems only, never values. */
export class CompositionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid DocMyRepos app composition:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CompositionError";
    this.problems = Object.freeze([...problems]);
  }
}

function compositionProblems(options: CreateAppOptions): string[] {
  const problems: string[] = [];
  for (const [name, hook] of Object.entries(options.hooks ?? {})) {
    if (!(HOOK_NAMES as readonly string[]).includes(name)) {
      problems.push(`hooks.${name} is not a hook`);
    } else if (typeof hook !== "function") {
      problems.push(`hooks.${name} is not a function`);
    }
  }
  for (const [name, adapter] of Object.entries(options.adapters ?? {})) {
    const methods = ADAPTER_METHODS[name as AdapterName] as readonly string[] | undefined;
    if (methods === undefined) {
      problems.push(`adapters.${name} is not an adapter`);
      continue;
    }
    for (const method of methods) {
      if (typeof (adapter as unknown as Record<string, unknown> | null)?.[method] !== "function") {
        problems.push(`adapters.${name}.${method} is not a function`);
      }
    }
  }
  const ids = new Set<string>();
  for (const plugin of options.plugins ?? []) {
    problems.push(...pluginProblems(plugin));
    if (ids.has(plugin.id)) problems.push(`plugin id "${plugin.id}" is used twice`);
    ids.add(plugin.id);
  }
  problems.push(...registryProblems(options.plugins ?? [], new Set(CORE_JOBS.keys())));
  return problems;
}

/**
 * Composes the application from configuration, hooks, adapters and plugins. Anything left out
 * uses its open-source default, so `createApp()` is the open-source app. Throws
 * `CompositionError` when the composition is invalid; never reads the database or the network.
 */
export function createApp(options: CreateAppOptions = {}): App {
  const problems = compositionProblems(options);
  if (problems.length > 0) throw new CompositionError(problems);
  const config = loadConfig(options.config);
  const runtime = runtimeRegistry();
  const baseAdapters = defaultAdapters(config, {
    adapters: () => adapters,
    runJob: (job, runOptions) => runJob(job, runOptions),
  });
  const adapters: Adapters = Object.freeze({ ...baseAdapters, ...options.adapters });
  const baseHooks = createDefaultHooks(config, adapters);
  const hooks: Hooks = Object.freeze({ ...baseHooks, ...options.hooks });
  const deps = { hooks, adapters };
  const registry = createPluginRegistry(options.plugins ?? []);
  const runJob = createJobRunner({
    handlers: new Map([...CORE_JOBS, ...registry.jobs]),
    listTenants: () => hooks.listTenants(),
    contextOf: (tenant) => createContext(deps, tenant, null),
  });
  const context = async (request: Request): Promise<RequestContext | null> => {
    const tenant = await resolveTenant(deps, request);
    return tenant === null ? null : createContext(deps, tenant, request);
  };
  return Object.freeze({
    apiVersion: EXTENSION_API_VERSION,
    config,
    hooks,
    adapters,
    defaults: Object.freeze({ hooks: baseHooks, adapters: baseAdapters }),
    plugins: registry.plugins,
    plugin: registry.plugin,
    runtime,
    start: () =>
      startApp(config, runtime, {
        secrets: adapters.secrets,
        listTenants: () => hooks.listTenants(),
        workspaceOf: (tenant) => createContext(deps, tenant, null).workspace(),
        submit: (job, runOptions) => adapters.jobs.submit(job, runOptions),
        schedules: registry.plugins.flatMap((plugin) => plugin.schedules ?? []),
      }),
    jobs: Object.freeze({ run: runJob }),
    slots: Object.freeze({
      resolve: <S extends SlotName>(slot: S, ctx: RequestContext, state?: CoreSlotState) =>
        resolveSlot(registry, slot, ctx, state),
    }),
    routes: coreRoutes(context, { config }),
    pluginRoutes: pluginRouteHandlers(registry, context),
    context,
    issueSession: async (
      ctx: RequestContext,
      userId: number,
      { secure = true }: { readonly secure?: boolean } = {},
    ) =>
      issueSessionCookie(await ctx.db(), ctx.tenant, userId, {
        sessionSecret: config.source.SESSION_SECRET?.trim() ?? "",
        secure,
      }),
    pageContext: cache(async () => context(requestFromHeaders(await headers()))),
  });
}
