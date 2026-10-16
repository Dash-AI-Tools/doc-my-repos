import { z } from "zod";

import type { RepoRemovalReason } from "../db/schema";
import { errorFields, logger, type LogFields, type Logger } from "../log";
import type { NameSelection } from "../sync/discovery";
import type { WebhookDispatch, WebhookPayload } from "./endpoint";

/**
 * The webhook event router (task 6.3): turns one verified GitHub App event into sync, removal or
 * status work. Pure over injected dependencies (no database, no Next.js), so every event is
 * unit-tested with fakes; `service.ts` wires the real sync engine.
 *
 * Contract with the endpoint (6.2): the returned dispatcher resolves quickly. Syncs, full syncs
 * and removals never run inside it: each is started as a background task handed to `deps.detach`,
 * with its own catch that logs fixed text, so a background failure can never reject the dispatch
 * or become an unhandled rejection. Only two single-statement database updates are awaited, so a
 * failure there answers 500 and GitHub can redeliver:
 *   - `repository` `privatized`: the stored row is made private at once (fail closed), before the
 *     follow-up sync confirms it;
 *   - `installation` `deleted` / `suspend`: every stored repo is marked `error` (content kept).
 *
 * Rules, per event:
 *   - Every handled event must carry `installation.id` equal to the configured installation id;
 *     other installations of the same App are ignored.
 *   - `push`: only a push to `refs/heads/<default_branch>` that does not delete the branch, for a
 *     non-archived repository inside the config narrowing, schedules a sync of that repository.
 *   - `repository`: `deleted` and `archived` remove the stored repo (authoritative signals);
 *     `privatized` updates visibility immediately and then syncs; `renamed` syncs when the new name
 *     is selected and removes the stored repo when the new name falls outside the narrowing;
 *     `created`, `edited`, `transferred`, `publicized`, `unarchived` sync when selected. Other
 *     actions are ignored.
 *   - `installation_repositories`: `added` syncs each selected repository (a full sync instead
 *     when the installation covers all repositories or the list is long); `removed` removes each
 *     listed repository.
 *   - `installation`: `deleted` / `suspend` mark every repo `error` and keep content;
 *     `unsuspend` / `created` / `new_permissions_accepted` schedule a full sync to recover.
 *   - Any other event, unknown action, or payload whose used fields do not validate is
 *     acknowledged and ignored.
 *
 * Ordering is not assumed (GitHub does not guarantee it): a sync goes through the installation
 * listing (`syncOne`), so a late `push` for a deleted repository finds nothing and creates nothing.
 *
 * Logging (structured, `../log`): one `webhook.decision` line per decision with `githubEvent`,
 * `action`, `deliveryId`, the `decision` word and, where relevant, `reason`, `githubId` or
 * `count`; background work reports `webhook.task.finished` / `webhook.task.failed` with the
 * engine's status word. No payload content (names, refs, commit messages) and no error text is
 * ever logged: repository names are attacker-controlled (log injection), so only GitHub ids are.
 */

/** More added repositories than this in one event are handled with a single full sync. */
export const MAX_INDIVIDUAL_ADDED = 10;

/** The error state message for `installation` `deleted` / `suspend` (recorded on every repo). */
export const INSTALLATION_UNAVAILABLE_MESSAGES = {
  deleted: "GitHub App installation unavailable (the App was uninstalled)",
  suspend: "GitHub App installation unavailable (the installation is suspended)",
} as const;

export type InstallationUnavailableReason = keyof typeof INSTALLATION_UNAVAILABLE_MESSAGES;

export interface WebhookRouterDeps {
  /** The configured installation id (from the workspace settings). */
  installationId: number;
  /** The config narrowing for a repository name (`repoNameSelection`). */
  narrow(name: string): NameSelection;
  /**
   * Syncs one repository by GitHub id with trigger `webhook`, resolving to a fixed status word
   * (`ok`, `coalesced`, `not_found`, ...). Coalesced with a running sync of the same repo
   * (task 6.4, `requestSync`).
   */
  syncRepo(githubId: number): Promise<string>;
  /** A full sync with trigger `webhook`, resolving to a fixed status word. */
  syncAll(): Promise<string>;
  /** Deletes a stored repo on an authoritative signal, resolving to a fixed status word. */
  removeRepo(githubId: number, reason: RepoRemovalReason): Promise<string>;
  /** Makes the stored row private now (one statement). Resolves whether a row changed. */
  markRepoPrivate(githubId: number): Promise<boolean>;
  /** Marks every stored repo `error` with the message for `reason` (one statement), keeping content. */
  markInstallationUnavailable(reason: InstallationUnavailableReason): Promise<number>;
  /** Takes a started background task. It never rejects (the router attached a catch). */
  detach?(task: Promise<void>): void;
  /** Structured log. Only fixed words and validated ids are passed. */
  log?: Logger;
}

// ---------------------------------------------------------------------------------------------
// Payload shapes: only the fields used. Extra fields pass; a wrong type for a used one fails.

const githubId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repoName = z.string().min(1).max(200);
const installation = z.object({ id: githubId });

const pushPayload = z.object({
  ref: z.string().max(1024),
  deleted: z.boolean().optional(),
  repository: z.object({
    id: githubId,
    name: repoName,
    default_branch: z.string().min(1).max(1024),
    archived: z.boolean().optional(),
  }),
  installation,
});

const repositoryPayload = z.object({
  action: z.string(),
  repository: z.object({ id: githubId, name: repoName, archived: z.boolean().optional() }),
  installation,
});

const installationRepositoriesPayload = z.object({
  action: z.string(),
  installation,
  repository_selection: z.string().optional(),
  repositories_added: z.array(z.object({ id: githubId, name: repoName })).optional(),
  repositories_removed: z.array(z.object({ id: githubId })).optional(),
});

const installationPayload = z.object({ action: z.string(), installation });

// ---------------------------------------------------------------------------------------------
// Logging helpers

const SAFE_ACTION = /^[a-z_]{1,64}$/;
const SAFE_EVENT = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_DELIVERY = /^[A-Za-z0-9-]{1,100}$/;

function actionOf(payload: WebhookPayload): string {
  const action = payload.action;
  return typeof action === "string" && SAFE_ACTION.test(action) ? action : "-";
}

interface Context {
  event: string;
  action: string;
  delivery: string;
}

function contextOf(event: string, payload: WebhookPayload, deliveryId: string | null): Context {
  return {
    event: SAFE_EVENT.test(event) ? event : "invalid",
    action: actionOf(payload),
    delivery:
      deliveryId === null ? "none" : SAFE_DELIVERY.test(deliveryId) ? deliveryId : "invalid",
  };
}

/** Status words from the engine are logged only when they look like one. */
function safeWord(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "unknown";
}

// ---------------------------------------------------------------------------------------------
// Router

const REPOSITORY_SYNC_ACTIONS: ReadonlySet<string> = new Set([
  "created",
  "edited",
  "transferred",
  "publicized",
  "unarchived",
]);

const INSTALLATION_RECOVER_ACTIONS: ReadonlySet<string> = new Set([
  "unsuspend",
  "created",
  "new_permissions_accepted",
]);

/** Builds the dispatcher for verified, non-ping events. See the module comment. */
export function createWebhookRouter(deps: WebhookRouterDeps): WebhookDispatch {
  const log = deps.log ?? logger;
  const detach = deps.detach ?? (() => undefined);

  function fieldsOf(ctx: Context, extra: LogFields): LogFields {
    return { githubEvent: ctx.event, action: ctx.action, deliveryId: ctx.delivery, ...extra };
  }

  function note(ctx: Context, decision: string, extra: LogFields = {}): void {
    log.info("webhook.decision", fieldsOf(ctx, { decision, ...extra }));
  }

  function ignore(ctx: Context, reason: string, extra: LogFields = {}): void {
    note(ctx, "ignored", { reason, ...extra });
  }

  /**
   * Starts `work` as a background task: deferred to a microtask (so even a synchronous throw is
   * caught), with a catch that logs fixed text. The dispatch never awaits it.
   */
  function background(
    ctx: Context,
    task: string,
    work: () => Promise<string | void>,
    extra: LogFields = {},
  ): void {
    const started = Promise.resolve()
      .then(work)
      .then(
        (status) =>
          log.info(
            "webhook.task.finished",
            fieldsOf(ctx, { task, ...extra, status: safeWord(status ?? "done") }),
          ),
        (error: unknown) =>
          log.warn("webhook.task.failed", fieldsOf(ctx, { task, ...extra, ...errorFields(error) })),
      )
      .catch(() => undefined);
    try {
      detach(started);
    } catch {
      // The task runs regardless; a broken scheduler only loses tracking.
    }
  }

  /** An awaited single-statement update. Rethrows a fixed error so nothing raw reaches the caller. */
  async function immediate<T>(ctx: Context, update: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      log.error("webhook.update_failed", fieldsOf(ctx, { update, ...errorFields(error) }));
      throw new Error(`webhook: ${update.replaceAll("_", " ")} failed`);
    }
  }

  function scheduleSync(ctx: Context, id: number): void {
    note(ctx, "sync_scheduled", { githubId: id });
    background(ctx, "sync", () => deps.syncRepo(id), { githubId: id });
  }

  function scheduleSyncAll(ctx: Context): void {
    note(ctx, "full_sync_scheduled");
    background(ctx, "full_sync", () => deps.syncAll());
  }

  function scheduleRemoval(ctx: Context, id: number, reason: RepoRemovalReason): void {
    note(ctx, "removal_scheduled", { githubId: id, reason });
    background(ctx, "removal", () => deps.removeRepo(id, reason), { githubId: id, reason });
  }

  function foreign(ctx: Context, id: number): boolean {
    if (id === deps.installationId) return false;
    ignore(ctx, "other_installation");
    return true;
  }

  function onPush(ctx: Context, payload: WebhookPayload): void {
    const parsed = pushPayload.safeParse(payload);
    if (!parsed.success) return ignore(ctx, "malformed_payload");
    const { ref, deleted, repository, installation } = parsed.data;
    if (foreign(ctx, installation.id)) return;
    const repo = { githubId: repository.id };
    if (ref !== `refs/heads/${repository.default_branch}`) {
      return ignore(ctx, "not_default_branch", repo);
    }
    if (deleted === true) return ignore(ctx, "branch_deleted", repo);
    if (repository.archived === true) return ignore(ctx, "archived", repo);
    if (deps.narrow(repository.name) !== "selected") return ignore(ctx, "not_selected", repo);
    scheduleSync(ctx, repository.id);
  }

  async function onRepository(ctx: Context, payload: WebhookPayload): Promise<void> {
    const parsed = repositoryPayload.safeParse(payload);
    if (!parsed.success) return ignore(ctx, "malformed_payload");
    const { action, repository, installation } = parsed.data;
    if (foreign(ctx, installation.id)) return;
    const id = repository.id;
    const repo = { githubId: id };
    const selection = deps.narrow(repository.name);

    switch (action) {
      case "deleted":
        return scheduleRemoval(ctx, id, "deleted");
      case "archived":
        return scheduleRemoval(ctx, id, "archived");
      case "privatized": {
        // Fail closed: private now, even before (or without) the follow-up sync.
        const changed = await immediate(ctx, "visibility_update", () => deps.markRepoPrivate(id));
        note(ctx, "visibility_private", { ...repo, changed });
        if (repository.archived === true) return ignore(ctx, "archived", repo);
        if (selection !== "selected") return ignore(ctx, "not_selected", repo);
        return scheduleSync(ctx, id);
      }
      case "renamed":
        if (repository.archived === true) return ignore(ctx, "archived", repo);
        if (selection === "selected") return scheduleSync(ctx, id);
        // Renamed out of the narrowing: the same removal a full sync would make.
        return scheduleRemoval(
          ctx,
          id,
          selection === "excluded" ? "excluded" : "dropped_from_config",
        );
      default:
        if (!REPOSITORY_SYNC_ACTIONS.has(action)) return ignore(ctx, "unhandled_action", repo);
        if (repository.archived === true) return ignore(ctx, "archived", repo);
        if (selection !== "selected") return ignore(ctx, "not_selected", repo);
        return scheduleSync(ctx, id);
    }
  }

  function onInstallationRepositories(ctx: Context, payload: WebhookPayload): void {
    const parsed = installationRepositoriesPayload.safeParse(payload);
    if (!parsed.success) return ignore(ctx, "malformed_payload");
    const { action, installation } = parsed.data;
    if (foreign(ctx, installation.id)) return;

    if (action === "added") {
      const added = parsed.data.repositories_added ?? [];
      if (parsed.data.repository_selection === "all" || added.length > MAX_INDIVIDUAL_ADDED) {
        return scheduleSyncAll(ctx);
      }
      const ids = [
        ...new Set(added.filter((r) => deps.narrow(r.name) === "selected").map((r) => r.id)),
      ];
      if (ids.length === 0) return ignore(ctx, "not_selected", { count: added.length });
      note(ctx, "sync_scheduled", { githubIds: ids, count: ids.length });
      // One background task, one repository at a time: each sync lists the installation.
      background(ctx, "sync_added", async () => {
        for (const id of ids) {
          try {
            const status = safeWord(await deps.syncRepo(id));
            log.info("webhook.task.repo", fieldsOf(ctx, { task: "sync", githubId: id, status }));
          } catch (error) {
            log.warn(
              "webhook.task.failed",
              fieldsOf(ctx, { task: "sync", githubId: id, ...errorFields(error) }),
            );
          }
        }
      });
      return;
    }

    if (action === "removed") {
      const ids = [...new Set((parsed.data.repositories_removed ?? []).map((r) => r.id))];
      if (ids.length === 0) return ignore(ctx, "empty_list");
      note(ctx, "removal_scheduled", { count: ids.length, reason: "not_in_installation" });
      background(ctx, "removal_removed", async () => {
        for (const id of ids) {
          try {
            const status = safeWord(await deps.removeRepo(id, "not_in_installation"));
            log.info(
              "webhook.task.repo",
              fieldsOf(ctx, {
                task: "removal",
                githubId: id,
                reason: "not_in_installation",
                status,
              }),
            );
          } catch (error) {
            log.warn(
              "webhook.task.failed",
              fieldsOf(ctx, { task: "removal", githubId: id, ...errorFields(error) }),
            );
          }
        }
      });
      return;
    }

    ignore(ctx, "unhandled_action");
  }

  async function onInstallation(ctx: Context, payload: WebhookPayload): Promise<void> {
    const parsed = installationPayload.safeParse(payload);
    if (!parsed.success) return ignore(ctx, "malformed_payload");
    const { action, installation } = parsed.data;
    if (foreign(ctx, installation.id)) return;

    if (action === "deleted" || action === "suspend") {
      const count = await immediate(ctx, "installation_error_marking", () =>
        deps.markInstallationUnavailable(action),
      );
      log.warn(
        "webhook.decision",
        fieldsOf(ctx, { decision: "installation_unavailable", reason: action, count }),
      );
      return;
    }
    if (INSTALLATION_RECOVER_ACTIONS.has(action)) return scheduleSyncAll(ctx);
    ignore(ctx, "unhandled_action");
  }

  return async (event, payload, deliveryId) => {
    const ctx = contextOf(event, payload, deliveryId);
    switch (event) {
      case "push":
        return onPush(ctx, payload);
      case "repository":
        return onRepository(ctx, payload);
      case "installation_repositories":
        return onInstallationRepositories(ctx, payload);
      case "installation":
        return onInstallation(ctx, payload);
      default:
        return ignore(ctx, "unhandled_event");
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Background task tracking

export interface BackgroundTasks {
  /** Tracks a started task until it settles. */
  detach(task: Promise<void>): void;
  /** Tasks still running. */
  readonly size: number;
  /** Resolves once no task is running, including tasks detached while waiting. For tests. */
  idle(): Promise<void>;
}

/** A tracker for detached tasks; `idle()` is the test hook that waits for them. */
export function createBackgroundTasks(): BackgroundTasks {
  const running = new Set<Promise<void>>();
  return {
    detach(task) {
      const tracked = task.catch(() => undefined).finally(() => running.delete(tracked));
      running.add(tracked);
    },
    get size() {
      return running.size;
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
