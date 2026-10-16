import "server-only";

import { Secret } from "../config/secret";
import type { Logger } from "../log";
import { getWorkspace, requireGitHub } from "../workspace";
import { repoNameSelection } from "../sync/discovery";
import { requestSync, syncAll, type RequestSyncResult, type SyncContext } from "../sync/engine";
import { removeRepo } from "../sync/removal";
import type { WebhookDispatch } from "./endpoint";
import { createBackgroundTasks, createWebhookRouter, type BackgroundTasks } from "./router";
import { markInstallationUnavailable, markRepoPrivate } from "./store";

/**
 * Binds the webhook handler to the environment and the event router (tasks 6.2, 6.3). Kept apart
 * from `route.ts` because a Next.js route file may export only route fields, and so tests can
 * replace it.
 */

/** How long a webhook removal waits for a running sync of the same repo before giving up. */
export const WEBHOOK_REMOVAL_LOCK_WAIT_MS = 30_000;

/**
 * The stored webhook secret, or null when none is saved or it cannot be read (no key, wrong key).
 * Never throws: a database problem reads as "no secret", which the endpoint answers with 401.
 */
export async function readConfiguredWebhookSecret(
  load: () => Promise<{ webhookSecret: Secret<string> | null }> = () => getWorkspace(),
): Promise<string | null> {
  try {
    return (await load()).webhookSecret?.reveal() ?? null;
  } catch {
    return null;
  }
}

export interface WebhookWiring {
  sync: SyncContext;
  /** The installation id from the workspace settings. */
  installationId: number;
  /** Where background syncs and removals are tracked. */
  tasks: BackgroundTasks;
  log?: Logger;
  removalLockWaitMs?: number;
}

/**
 * The status word logged for a webhook sync request: the last pass's repo status (`ok`,
 * `unchanged`, `error`, `skipped`) or `not_found` / `not_configured` / `discovery_failed`;
 * `coalesced` when another sync held the repo (it reruns for this delivery); `busy` when a
 * never-synced repo stayed locked past the queue wait; `aborted`.
 */
export function requestSyncStatus(result: RequestSyncResult): string {
  switch (result.status) {
    case "done": {
      const last = result.result;
      return last.status === "synced" ? (last.result?.status ?? "skipped") : last.status;
    }
    default:
      return result.status;
  }
}

/**
 * The event router over the real sync engine. Background work is tracked in `wiring.tasks`.
 *
 * Repeated and concurrent deliveries (task 6.4): every repo sync goes through `requestSync`, so a
 * delivery that arrives while the repo is syncing is coalesced into a rerun of that sync rather
 * than run in parallel or dropped, and a duplicate delivery re-runs an idempotent sync (an
 * unchanged tree short-circuits after one branch request). Deliveries are not deduplicated by
 * `X-GitHub-Delivery`: correctness does not depend on it, and GitHub's "Redeliver" reuses the id,
 * so an operator's manual redelivery must still sync.
 */
export function createWebhookDispatch(wiring: WebhookWiring): WebhookDispatch {
  const { sync } = wiring;
  const rearm = (task: Promise<void>) => wiring.tasks.detach(task);
  return createWebhookRouter({
    installationId: wiring.installationId,
    narrow: (name) => repoNameSelection(sync.config, name),
    syncRepo: async (githubId) =>
      requestSyncStatus(await requestSync(sync, { githubId }, { trigger: "webhook", rearm })),
    syncAll: async () => {
      const result = await syncAll(sync, { trigger: "webhook", rearm });
      return result.run.ran ? (result.fatal === null ? "done" : "failed") : "not_run";
    },
    removeRepo: async (githubId, reason) =>
      (
        await removeRepo(sync.db, sync.pool, { githubId }, reason, {
          lockWaitMs: wiring.removalLockWaitMs ?? WEBHOOK_REMOVAL_LOCK_WAIT_MS,
        })
      ).status,
    markRepoPrivate: (githubId) => markRepoPrivate(sync.db, githubId),
    markInstallationUnavailable: (reason) => markInstallationUnavailable(sync.db, reason),
    detach: wiring.tasks.detach,
    log: wiring.log,
  });
}

const TASKS_KEY = Symbol.for("docmyrepos.webhookTasks");
type TasksCache = { [TASKS_KEY]?: BackgroundTasks };

/** Background webhook work of this process (kept on `globalThis` across Next.js dev reloads). */
export function webhookTasks(): BackgroundTasks {
  const cache = globalThis as TasksCache;
  cache[TASKS_KEY] ??= createBackgroundTasks();
  return cache[TASKS_KEY];
}

/**
 * The dispatcher for verified events. It is called only after the signature is verified, so it
 * loads the current workspace lazily; incomplete GitHub settings reject the dispatch (500, GitHub
 * may redeliver) without logging any value.
 */
export function getWebhookDispatch(): WebhookDispatch {
  return async (event, payload, deliveryId) => {
    const github = requireGitHub(await getWorkspace());
    return createWebhookDispatch({
      sync: github.sync,
      installationId: github.installationId,
      tasks: webhookTasks(),
    })(event, payload, deliveryId);
  };
}
