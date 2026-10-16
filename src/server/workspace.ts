import "server-only";

import { type Db, type DbHandle, getDb, redactWhenLogged } from "./db/client";
import { Secret } from "./config/secret";
import type { AppConfig } from "./config/schema";
import { createInstallationTokenProvider } from "./github/app-auth";
import { createGitHubClient, type GitHubClient } from "./github/client";
import { errorFields, logger } from "./log";
import { ENCRYPTION_KEY_VAR, parseEncryptionKey, type EncryptionKey } from "./settings/crypto";
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
 * - `getWorkspace()` caches the built workspace by settings version. It re-checks the version at
 *   most every `RECHECK_MS`, and a save in this process drops the cache at once, so a change shows
 *   on the next operation (other instances within the interval).
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

  const key = parseEncryptionKey(env[ENCRYPTION_KEY_VAR]);
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
const CACHE_KEY = Symbol.for("docmyrepos.workspace");
const BUILD_KEY = Symbol.for("docmyrepos.workspaceBuild");
type Cache = { [CACHE_KEY]?: CacheEntry; [BUILD_KEY]?: Promise<Workspace> };

/**
 * The shared workspace. Reuses the cached one while its settings version is current (checked at
 * most every `RECHECK_MS`); `fresh: true` checks now. If the database cannot be reached while a
 * cached workspace exists, that one keeps being served. Options are used only when a build happens.
 */
export async function getWorkspace(
  options: WorkspaceOptions & { fresh?: boolean } = {},
): Promise<Workspace> {
  const cache = globalThis as Cache;
  const interval = options.recheckMs ?? RECHECK_MS;
  const entry = cache[CACHE_KEY];
  const now = Date.now();
  if (entry && !options.fresh && now - entry.checkedAt < interval) return entry.workspace;

  if (entry) {
    try {
      const version = await readVersion((options.handle ?? getDb()).db);
      if (version === entry.workspace.version) {
        entry.checkedAt = now;
        return entry.workspace;
      }
    } catch (error) {
      logger.warn("workspace.recheck_failed", errorFields(error));
      return entry.workspace;
    }
  }

  // One build at a time; concurrent callers share it.
  cache[BUILD_KEY] ??= createWorkspace(options)
    .then((workspace) => {
      cache[CACHE_KEY] = { workspace, checkedAt: Date.now() };
      return workspace;
    })
    .finally(() => {
      delete cache[BUILD_KEY];
    });
  return cache[BUILD_KEY];
}

/** Drops the cached workspace so the next `getWorkspace()` rebuilds. Called after a save. */
export function invalidateWorkspace(): void {
  delete (globalThis as Cache)[CACHE_KEY];
}

/** Whether comments are on, from the current settings. May reject when the database is down. */
export async function commentsEnabled(): Promise<boolean> {
  return (await getWorkspace()).config.comments.enabled;
}
