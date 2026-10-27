import type {
  Action,
  DomainEvent,
  DomainEventInput,
  Feature,
  JsonValue,
  PluginDefinition,
  Resource,
  TenantContext,
  User,
} from "@docmyrepos/core";

import type { Db, DbHandle } from "../db/client";
import type { Logger } from "../log";
import type { EncryptionKey } from "../settings/crypto";
import type { Workspace } from "../workspace";

/**
 * Everything a request or job runs with: its tenant and the tenant's database and workspace, the
 * signed-in user, permission and entitlement checks and event emission. Built once per request
 * (`app.context`, `app.pageContext`) or job, and passed explicitly to the code that needs it.
 */
export interface RequestContext {
  readonly tenant: TenantContext;
  /** Structured logger; lines carry the tenant id unless it is the built-in tenant. */
  readonly log: Logger;
  /** The tenant's database, through the database adapter. */
  db(): Promise<Db>;
  /** The tenant's database handle (pool included), for code that takes locks. */
  dbHandle(): Promise<DbHandle>;
  /**
   * The tenant's workspace settings, cached per tenant. `fresh` re-checks the settings version now
   * (after a save, or where a stale view would mislead).
   */
  workspace(options?: { readonly fresh?: boolean }): Promise<Workspace>;
  /** The key of the tenant's stored secrets, from the secrets adapter. */
  encryptionKey(): Promise<EncryptionKeyResult>;
  /** The signed-in user (`authenticate`), memoized for the request; null for a job. */
  user(): Promise<User | null>;
  /** `authorize` for the current user; false when the hook fails. */
  can(action: Action, resource?: Resource): Promise<boolean>;
  /** `checkEntitlement` for the tenant; false when the hook fails. */
  entitled(feature: Feature): Promise<boolean>;
  /** Hands an event to `onEvent` after the fact; never waits for it and never throws. */
  emit(event: DomainEventInput): void;
  /** The app's infrastructure for files, mail and background jobs; each call names the tenant. */
  readonly adapters: Pick<Adapters, "blobs" | "email" | "jobs">;
}

/** The decisions an external layer can take over. Each has an open-source default. */
export interface Hooks {
  /** The tenant of an incoming request, or null when it matches none (answered 404). */
  resolveTenant(request: Request): TenantContext | null | Promise<TenantContext | null>;
  /** The tenants background work runs for. */
  listTenants(): readonly TenantContext[] | Promise<readonly TenantContext[]>;
  /** The signed-in user of a request, or null. */
  authenticate(request: Request, tenant: TenantContext): Promise<User | null>;
  /** Whether the context's user may take `action` on `resource`. */
  authorize(ctx: RequestContext, action: Action, resource: Resource): boolean | Promise<boolean>;
  /** Whether the context's tenant may use `feature`. */
  checkEntitlement(ctx: RequestContext, feature: Feature): boolean | Promise<boolean>;
  /** Receives every domain event after the action it describes. */
  onEvent(event: DomainEvent): void | Promise<void>;
}

export type HookName = keyof Hooks;

export const HOOK_NAMES = [
  "resolveTenant",
  "listTenants",
  "authenticate",
  "authorize",
  "checkEntitlement",
  "onEvent",
] as const satisfies readonly HookName[];

/** Provides the Postgres database of each tenant. */
export interface DatabaseAdapter {
  forTenant(tenant: TenantContext): Promise<DbHandle>;
}

export type EncryptionKeyResult =
  | { readonly key: EncryptionKey; readonly problem: null }
  | { readonly key: null; readonly problem: string };

/** Provides the key that encrypts each tenant's stored workspace secrets. */
export interface SecretsAdapter {
  encryptionKey(tenant: TenantContext): Promise<EncryptionKeyResult>;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** A stored file: its bytes and MIME type. */
export interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Stores each tenant's binary files by name. The core stores one, `branding/logo`; its size and
 * type are validated before it reaches the store.
 */
export interface BlobStore {
  get(tenant: TenantContext, name: string): Promise<StoredBlob | null>;
  put(tenant: TenantContext, name: string, blob: StoredBlob): Promise<void>;
  delete(tenant: TenantContext, name: string): Promise<void>;
}

/** A named unit of background work. The payload is JSON and always names its tenant. */
export interface Job {
  readonly name: string;
  readonly payload: { readonly tenantId: string; readonly [key: string]: JsonValue };
}

export interface JobRunOptions {
  /** Aborts the job; only an in-process run can be given one. */
  readonly signal?: AbortSignal;
}

/**
 * Runs or queues background jobs. An adapter that runs a job in this process returns `done`,
 * which settles with the job; a queue returns no `done`, and its worker calls `app.jobs.run`.
 */
export interface JobsAdapter {
  submit(job: Job, options?: JobRunOptions): Promise<{ readonly done?: Promise<void> }>;
}

/** Sends mail for plugins. The open-source core sends none. */
export interface EmailAdapter {
  send(tenant: TenantContext, message: EmailMessage): Promise<void>;
}

/** The infrastructure the core runs on. Each has an open-source default. */
export interface Adapters {
  readonly database: DatabaseAdapter;
  readonly secrets: SecretsAdapter;
  readonly blobs: BlobStore;
  readonly email: EmailAdapter;
  readonly jobs: JobsAdapter;
}

export type AdapterName = keyof Adapters;

export const ADAPTER_METHODS: { readonly [K in AdapterName]: readonly (keyof Adapters[K])[] } = {
  database: ["forTenant"],
  secrets: ["encryptionKey"],
  blobs: ["get", "put", "delete"],
  jobs: ["submit"],
  email: ["send"],
};

/** A plugin for this server: its handlers and contributions receive a `RequestContext`. */
export type Plugin = PluginDefinition<RequestContext, unknown>;
