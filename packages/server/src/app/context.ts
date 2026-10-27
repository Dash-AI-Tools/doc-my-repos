import {
  EVENT_SCHEMA_VERSION,
  WORKSPACE,
  isDefaultTenant,
  type DomainEvent,
  type TenantContext,
  type User,
} from "@docmyrepos/core";
import { PATHNAME_HEADER } from "@docmyrepos/core/internal/security-headers";

import { contextAccess } from "../auth/access";
import type { DbHandle } from "../db/client";
import { errorFields, logger as processLogger, type Logger } from "../log";
import type { EncryptionKey } from "../settings/crypto";
import { getWorkspace, type Workspace } from "../workspace";
import type { Adapters, EncryptionKeyResult, HookName, Hooks, RequestContext } from "./types";

/** What a context is built from: the app's hooks and adapters. */
export interface ContextDeps {
  readonly hooks: Hooks;
  readonly adapters: Adapters;
  /** Default: the process logger. */
  readonly log?: Logger;
}

/** Reports a hook that threw or rejected: its name only, never request data or the error text. */
function hookFailed(log: Logger, hook: HookName, error: unknown): void {
  log.warn("hook.failed", { hook, errorName: errorFields(error).errorName });
}

/**
 * Runs a hook that decides access. A hook that throws or rejects counts as `fallback` (deny), so
 * a broken host hook never opens anything up.
 */
async function decide<T>(
  log: Logger,
  hook: HookName,
  fallback: T,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    hookFailed(log, hook, error);
    return fallback;
  }
}

/** The request's tenant (`resolveTenant`), or null when it has none or the hook fails. */
export function resolveTenant(deps: ContextDeps, request: Request): Promise<TenantContext | null> {
  const log = deps.log ?? processLogger;
  return decide(log, "resolveTenant", null, () => deps.hooks.resolveTenant(request));
}

/**
 * The context of one request (`request`) or job (`request` null) for `tenant`. Lazy: nothing is
 * read until a member is called, and each read happens once per context.
 */
export function createContext(
  deps: ContextDeps,
  tenant: TenantContext,
  request: Request | null,
): RequestContext {
  const base = deps.log ?? processLogger;
  // Lines of the built-in tenant are unchanged; any other tenant is named on every line.
  const log = isDefaultTenant(tenant) ? base : base.child({ tenant: tenant.id });
  let handle: Promise<DbHandle> | undefined;
  let workspace: Promise<Workspace> | undefined;
  let user: Promise<User | null> | undefined;
  let key: Promise<EncryptionKeyResult> | undefined;

  const ctx: RequestContext = {
    tenant,
    log,
    adapters: { blobs: deps.adapters.blobs, email: deps.adapters.email, jobs: deps.adapters.jobs },
    dbHandle: () => (handle ??= deps.adapters.database.forTenant(tenant)),
    db: async () => (await ctx.dbHandle()).db,
    encryptionKey: () => (key ??= deps.adapters.secrets.encryptionKey(tenant)),
    workspace: (options = {}) => {
      const build = async (fresh: boolean) =>
        getWorkspace({
          handle: await ctx.dbHandle(),
          tenantId: tenant.id,
          encryptionKey: await ctx.encryptionKey(),
          emit: ctx.emit,
          fresh,
        });
      if (options.fresh) workspace = build(true);
      return (workspace ??= build(false));
    },
    user: () =>
      (user ??=
        request === null
          ? Promise.resolve(null)
          : decide(log, "authenticate", null, () => deps.hooks.authenticate(request, tenant))),
    can: (action, resource = WORKSPACE) =>
      decide(log, "authorize", false, () => deps.hooks.authorize(ctx, action, resource)),
    entitled: (feature) =>
      decide(log, "checkEntitlement", false, () => deps.hooks.checkEntitlement(ctx, feature)),
    emit: (input) => {
      const event = {
        name: input.name,
        schemaVersion: EVENT_SCHEMA_VERSION,
        tenantId: tenant.id,
        at: new Date().toISOString(),
        actorId: input.actorId ?? null,
        payload: input.payload,
      } as DomainEvent;
      // Detached: the action never waits for the hook, and a failing hook changes nothing.
      void Promise.resolve()
        .then(() => deps.hooks.onEvent(event))
        .catch((error: unknown) => {
          log.warn("hook.failed", {
            hook: "onEvent",
            eventName: event.name,
            errorName: errorFields(error).errorName,
          });
        });
    },
  };
  return ctx;
}

/**
 * The request a server component is rendering, rebuilt from its headers: server components see
 * headers but not the URL, so the proxy forwards the path in `x-dmr-pathname`.
 */
export function requestFromHeaders(headers: Headers): Request {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const path = headers.get(PATHNAME_HEADER) ?? "/";
  let url: URL;
  try {
    url = new URL(`${proto}://${host}`);
  } catch {
    url = new URL("http://localhost");
  }
  // Set as a path, never parsed as a URL: `//other.host` must not change the host.
  url.pathname = path.startsWith("/") ? path : "/";
  return new Request(url, { headers });
}

/**
 * What the admin and settings handlers need of a request beyond its database: the tenant whose
 * workspace a save invalidates, and that tenant's workspace.
 */
export function tenantDeps(ctx: RequestContext): {
  readonly db: RequestContext["db"];
  readonly tenantId: string;
  readonly workspace: (fresh: boolean) => Promise<Workspace>;
  readonly admin: () => Promise<User>;
  readonly encryptionKey: () => Promise<EncryptionKey | null>;
  readonly emit: RequestContext["emit"];
} {
  return {
    db: ctx.db,
    tenantId: ctx.tenant.id,
    workspace: (fresh) => ctx.workspace({ fresh }),
    admin: () => contextAccess(ctx).admin(),
    encryptionKey: async () => (await ctx.encryptionKey()).key,
    emit: ctx.emit,
  };
}

/** Thrown by `requireContextUser` when nobody is signed in: the 401 of `requireUser`. */
function unauthorized(): Error & { status: number } {
  return Object.assign(new Error("unauthorized"), { status: 401 });
}

/**
 * The signed-in user of a request context, or the 401 error the handlers' `requireUser` throws:
 * for handlers that take their user as a dependency.
 */
export async function requireContextUser(ctx: RequestContext): Promise<User> {
  const user = await ctx.user();
  if (user === null) throw unauthorized();
  return user;
}
