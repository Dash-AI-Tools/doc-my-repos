import type { TenantContext } from "./tenant";

/** How a sync started (the `sync_trigger` column). */
export type SyncTrigger = "webhook" | "manual" | "schedule" | "startup";

/**
 * The payload of each domain event. Ids and counts only: never document content, search queries,
 * comment text, prompts, answers, email addresses or secrets.
 */
export interface EventPayloads {
  "sync.completed": {
    readonly githubRepoId: number;
    readonly trigger: SyncTrigger;
    readonly added: number;
    readonly changed: number;
    readonly removed: number;
  };
  "sync.failed": {
    readonly githubRepoId: number;
    readonly trigger: SyncTrigger;
    /** A fixed failure kind, never an error message. */
    readonly reason: string;
  };
  "auth.login_succeeded": { readonly userId: number };
  "auth.login_failed": Readonly<Record<string, never>>;
  "auth.logout": { readonly userId: number | null };
  "user.created": { readonly userId: number; readonly role: "admin" | "user" };
  "user.updated": { readonly userId: number; readonly fields: readonly string[] };
  "token.created": { readonly tokenId: number; readonly ownerId: number };
  "token.revoked": { readonly tokenId: number; readonly ownerId: number };
  "settings.updated": { readonly version: number; readonly sections: readonly string[] };
  "branding.updated": { readonly logoChanged: boolean };
  "repo.access_changed": { readonly githubRepoId: number; readonly allowed: boolean };
  "repo.public_changed": { readonly githubRepoId: number; readonly public: boolean };
  "folder.public_changed": { readonly folderId: number; readonly public: boolean };
  "comment.created": {
    readonly commentId: number;
    readonly githubRepoId: number;
    readonly asOrganization: boolean;
    readonly reply: boolean;
  };
  "comment.deleted": {
    readonly commentId: number;
    readonly githubRepoId: number;
    readonly byModerator: boolean;
  };
  "search.performed": { readonly resultCount: number; readonly scoped: boolean };
  "ask.answered": {
    readonly provider: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  "mcp.tool_called": { readonly tool: string; readonly outcome: "ok" | "error" };
}

export type EventName = keyof EventPayloads;

/** Every event name the core emits. */
export const EVENT_NAMES = [
  "sync.completed",
  "sync.failed",
  "auth.login_succeeded",
  "auth.login_failed",
  "auth.logout",
  "user.created",
  "user.updated",
  "token.created",
  "token.revoked",
  "settings.updated",
  "branding.updated",
  "repo.access_changed",
  "repo.public_changed",
  "folder.public_changed",
  "comment.created",
  "comment.deleted",
  "search.performed",
  "ask.answered",
  "mcp.tool_called",
] as const satisfies readonly EventName[];

/** The schema version of the event envelope and payloads. */
export const EVENT_SCHEMA_VERSION = 1;

/** One event as `onEvent` receives it. */
export type DomainEvent<N extends EventName = EventName> = {
  [K in N]: {
    readonly name: K;
    readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
    readonly tenantId: TenantContext["id"];
    /** ISO 8601 time the action completed. */
    readonly at: string;
    /** The signed-in user who acted, or null (sync, webhook, failed login). */
    readonly actorId: number | null;
    readonly payload: EventPayloads[K];
  };
}[N];

/** What a caller passes to emit an event; the envelope is stamped for it. */
export type DomainEventInput<N extends EventName = EventName> = {
  [K in N]: {
    readonly name: K;
    readonly payload: EventPayloads[K];
    readonly actorId?: number | null;
  };
}[N];
