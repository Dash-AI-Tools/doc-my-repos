import "server-only";

import { DEFAULT_TENANT_ID, type DomainEventInput } from "@docmyrepos/core";

import { type Db, type DbHandle, getDb, redactWhenLogged } from "./db/client";
import { Secret } from "./config/secret";
import type { AppConfig } from "@docmyrepos/core/internal/config/schema";
import { createInstallationTokenProvider } from "./github/app-auth";
import { createGitHubClient, type GitHubClient } from "./github/client";
import { errorFields, logger } from "./log";
import { encryptionKeyFrom, type EncryptionKey } from "./settings/crypto";
import { readSecrets, readSettings, readVersion } from "./settings/store";
import { createSyncContext, type SyncContext, type SyncTuning } from "./sync/engine";

/**
 * The workspace: the settings an administrator manages (GitHub App, repository scope, limits,
 * provider credentials), loaded from the database and turned into the GitHub client and sync
 * context (workspace-settings design decisions 4, 5 and 8).
 *
 * - Nothing is read, connected or minted at import time.
 * - A workspace that is not fully configured is a normal state, not an error: `github` is null and
 *   `problems` names what is missing. Callers answer "not configured" without calling GitHub.
 * - The result is immutable. A sync or an answer in progress keeps the workspace it started with.
 * - `getWorkspace()` caches the built workspace per tenant, by settings version. It re-checks the
 *   version at most every `RECHECK_MS`, and a save in this process drops that tenant's entry at
 *   once, so a change shows on the next operation (other instances within the interval).
 * - Secrets stay wrapped in `Secret`; the workspace object prints as `[redacted]`.
 */

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type WorkspaceConfig = DeepReadonly<AppConfig>;

/** What a configured workspace can do against GitHub. */
export interface GitHubParts {
  readonly installationId: number;
  readonly client: GitHubClient;
  /** For the image proxy: tuned to fail fast. */
  readonly assets: GitHubClient;
  readonly sync: SyncContext;
}

/** Names of settings that are missing or unusable, never values. */
export interface WorkspaceProblems {
  /** `github.appId`, `github.installationId`, `github_private_key`. */
  readonly missingGithub: readonly string[];
  /** Why secrets cannot be read at all (key variable missing or invalid), or null. */
  readonly encryptionKey: string | null;
  /** Secrets that exist but could not be decrypted. */
  readonly unreadable: readonly string[];
  /** The stored settings no longer pass validation; defaults are in use. */
  readonly invalidStored: boolean;
}

export interface ProviderSettings {
  readonly anthropicKey: Secret<string> | null;
  readonly openaiKey: Secret<string> | null;
  readonly openaiBaseUrl: string | null;
}

export interface Workspace {
  readonly version: number;
  readonly config: WorkspaceConfig;
  /** Null until the App id, installation id and private key are all set and readable. */
  readonly github: GitHubParts | null;
  readonly webhookSecret: Secret<string> | null;
  readonly providers: ProviderSettings;
  readonly problems: WorkspaceProblems;
}

export interface WorkspaceOptions {
  /** The database. Default: the shared handle. */
  readonly handle?: DbHandle;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives the domain events of the workspace's syncs (the request context's `emit`). */
  readonly emit?: (event: DomainEventInput) => void;
  /**
   * The key of the tenant's stored secrets (the secrets adapter's). Default: the startup
   * configuration's key, from `env`.
   */
  readonly encryptionKey?:
    | { readonly key: EncryptionKey; readonly problem: null }
    | { readonly key: null; readonly problem: string };
  /** `fetch` for GitHub (API and token minting). Defaults to the global one. */
  readonly fetch?: typeof fetch;
  readonly tuning?: SyncTuning;
  /** Test hook for the re-check interval. */
  readonly recheckMs?: number;
}

export const RECHECK_MS = 5_000;

/** Thrown to callers that need GitHub when the workspace has none. Names only, no values. */
export class NotConfiguredError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`GitHub is not configured (missing: ${missing.join(", ")})`);
    this.name = "NotConfiguredError";
    this.missing = Object.freeze([...missing]);
  }
}

/** The GitHub parts, or `NotConfiguredError`. For entry points that cannot proceed without them. */
export function requireGitHub(workspace: Workspace): GitHubParts {
  if (workspace.github === null) {
    throw new NotConfiguredError(
      workspace.problems.missingGithub.length > 0
        ? workspace.problems.missingGithub
        : ["github_private_key"],
    );
  }
  return workspace.github;
}

/** Builds a workspace from the database. No caching; see `getWorkspace`. */
export async function createWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const handle = options.handle ?? getDb();
  const env = options.env ?? process.env;
  const db: Db = handle.db;

  const key = options.encryptionKey ?? encryptionKeyFrom(env);
  const snapshot = await readSettings(db);
  const secrets: Awaited<ReturnType<typeof readSecrets>> =
    key.key === null
      ? { values: {}, unreadable: [] }
      : await readSecrets(db, key.key as EncryptionKey);

  const config = snapshot.settings as WorkspaceConfig;
  const privateKey = secrets.values.github_private_key ?? null;
  const missingGithub = [
    ...(config.github.appId === undefined ? ["github.appId"] : []),
    ...(config.github.installationId === undefined ? ["github.installationId"] : []),
    ...(privateKey === null ? ["github_private_key"] : []),
  ];

  let github: GitHubParts | null = null;
  if (missingGithub.length === 0 && privateKey !== null) {
    const installationId = config.github.installationId as number;
    const tokens = createInstallationTokenProvider({
      appId: config.github.appId as number,
      installationId,
      privateKey,
      fetch: options.fetch,
    });
    const client = createGitHubClient({ getToken: tokens.getToken, fetch: options.fetch });
    const assets = createGitHubClient({
      getToken: tokens.getToken,
      fetch: options.fetch,
      maxAttempts: 2,
      maxWaitMs: 1000,
      baseBackoffMs: 200,
    });
    const sync = createSyncContext({
      db,
      pool: handle.pool,
      github: client,
      config: config,
      tuning: options.tuning,
      emit: options.emit,
    });
    github = { installationId, client, assets, sync };
  }

  return Object.freeze(
    redactWhenLogged({
      version: snapshot.version,
      config,
      github,
      webhookSecret: secrets.values.github_webhook_secret ?? null,
      providers: {
        anthropicKey: secrets.values.anthropic_api_key ?? null,
        openaiKey: secrets.values.openai_api_key ?? null,
        openaiBaseUrl: config.providers.openaiBaseUrl ?? null,
      },
      problems: {
        missingGithub,
        encryptionKey: key.problem,
        unreadable: secrets.unreadable,
        invalidStored: !snapshot.valid,
      },
    }),
  );
}

interface CacheEntry {
  workspace: Workspace;
  checkedAt: number;
}

/**
 * Most workspaces kept in memory. The open-source app has one; a host serving many tenants from
 * one process keeps the most recently used ones, and a dropped one is simply rebuilt on its next
 * use.
 */
export const MAX_CACHED_WORKSPACES = 500;

interface WorkspaceCache {
  /** Built workspaces by tenant id, least recently used first. */
  readonly entries: Map<string, CacheEntry>;
  /** Builds in progress by tenant id; concurrent callers share one. */
  readonly builds: Map<string, Promise<Workspace>>;
}

const CACHE_KEY = Symbol.for("docmyrepos.workspaces");
type Holder = { [CACHE_KEY]?: WorkspaceCache };

function workspaceCache(): WorkspaceCache {
  const holder = globalThis as Holder;
  holder[CACHE_KEY] ??= { entries: new Map(), builds: new Map() };
  return holder[CACHE_KEY];
}

function remember(cache: WorkspaceCache, tenantId: string, entry: CacheEntry): void {
  cache.entries.delete(tenantId);
  cache.entries.set(tenantId, entry);
  while (cache.entries.size > MAX_CACHED_WORKSPACES) {
    const oldest = cache.entries.keys().next().value as string;
    cache.entries.delete(oldest);
  }
}

export interface GetWorkspaceOptions extends WorkspaceOptions {
  /** The tenant whose workspace this is. Default: the built-in tenant. */
  readonly tenantId?: string;
  /** Re-check the settings version now instead of within `RECHECK_MS`. */
  readonly fresh?: boolean;
}

/**
 * A tenant's workspace, cached per tenant. Reuses the cached one while its settings version is
 * current (checked at most every `RECHECK_MS`); `fresh: true` checks now. If the database cannot
 * be reached while a cached workspace exists, that one keeps being served. Options are used only
 * when a build happens. A tenant other than the built-in one must pass its database `handle`.
 */
export async function getWorkspace(options: GetWorkspaceOptions = {}): Promise<Workspace> {
  const cache = workspaceCache();
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  if (tenantId !== DEFAULT_TENANT_ID && options.handle === undefined) {
    throw new Error(`the workspace of tenant "${tenantId}" needs its database handle`);
  }
  const interval = options.recheckMs ?? RECHECK_MS;
  const entry = cache.entries.get(tenantId);
  const now = Date.now();
  if (entry && !options.fresh && now - entry.checkedAt < interval) {
    remember(cache, tenantId, entry);
    return entry.workspace;
  }

  if (entry) {
    try {
      const version = await readVersion((options.handle ?? getDb()).db);
      if (version === entry.workspace.version) {
        entry.checkedAt = now;
        remember(cache, tenantId, entry);
        return entry.workspace;
      }
    } catch (error) {
      logger.warn("workspace.recheck_failed", errorFields(error));
      return entry.workspace;
    }
  }

  // One build at a time per tenant; concurrent callers share it.
  let build = cache.builds.get(tenantId);
  if (build === undefined) {
    build = createWorkspace(options)
      .then((workspace) => {
        remember(cache, tenantId, { workspace, checkedAt: Date.now() });
        return workspace;
      })
      .finally(() => {
        cache.builds.delete(tenantId);
      });
    cache.builds.set(tenantId, build);
  }
  return build;
}

/**
 * Drops a tenant's cached workspace (default: the built-in tenant's) so its next `getWorkspace()`
 * rebuilds. Called after a save; other tenants' workspaces are untouched.
 */
export function invalidateWorkspace(tenantId: string = DEFAULT_TENANT_ID): void {
  workspaceCache().entries.delete(tenantId);
}

/** Test seam: the cached workspace of a tenant (default: the built-in tenant), if any. */
export function cachedWorkspace(tenantId: string = DEFAULT_TENANT_ID): Workspace | undefined {
  return workspaceCache().entries.get(tenantId)?.workspace;
}

/** Test seam: forgets every cached workspace and build in progress. */
export function resetWorkspaceCache(): void {
  delete (globalThis as Holder)[CACHE_KEY];
}

/**
 * Where a switch is read from: a request context's tenant workspace and, when given, its
 * entitlements (`checkEntitlement`): a feature the tenant is not entitled to is off.
 */
export interface WorkspaceSource {
  workspace(): Promise<Workspace>;
  entitled?(feature: "mcp" | "comments"): Promise<boolean>;
}

/**
 * Whether the MCP endpoint is on for the context's tenant (default: the built-in tenant), from
 * the current settings. May reject when the database is down.
 */
export async function mcpEnabled(ctx?: WorkspaceSource): Promise<boolean> {
  const on = (await (ctx ? ctx.workspace() : getWorkspace())).config.mcp.enabled;
  return on && (ctx?.entitled ? await ctx.entitled("mcp") : true);
}

/**
 * Whether comments are on for the context's tenant (default: the built-in tenant), from the
 * current settings. May reject when the database is down.
 */
export async function commentsEnabled(ctx?: WorkspaceSource): Promise<boolean> {
  const on = (await (ctx ? ctx.workspace() : getWorkspace())).config.comments.enabled;
  return on && (ctx?.entitled ? await ctx.entitled("comments") : true);
}
