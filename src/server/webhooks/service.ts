import "server-only";

import { readWebhookSecret, type EnvSource } from "../config/env";
import { getRuntime } from "../runtime";
import { repoNameSelection } from "../sync/discovery";
import { syncAll, syncOne, type SyncContext } from "../sync/engine";
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

/** The configured webhook secret from the environment, or null. Reads no file and opens no connection. */
export function readConfiguredWebhookSecret(env: EnvSource = process.env): string | null {
  return readWebhookSecret(env)?.reveal() ?? null;
}

export interface WebhookWiring {
  sync: SyncContext;
  /** `GITHUB_APP_INSTALLATION_ID`. */
  installationId: number;
  /** Where background syncs and removals are tracked. */
  tasks: BackgroundTasks;
  log?: (message: string, ...details: string[]) => void;
  removalLockWaitMs?: number;
}

/** The event router over the real sync engine. Background work is tracked in `wiring.tasks`. */
export function createWebhookDispatch(wiring: WebhookWiring): WebhookDispatch {
  const { sync } = wiring;
  return createWebhookRouter({
    installationId: wiring.installationId,
    narrow: (name) => repoNameSelection(sync.config, name),
    syncRepo: async (githubId) => {
      const result = await syncOne(sync, { githubId }, { trigger: "webhook" });
      return result.status === "synced" ? (result.result?.status ?? "skipped") : result.status;
    },
    syncAll: async () => {
      const result = await syncAll(sync, { trigger: "webhook" });
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
 * builds the shared runtime (`getRuntime()`) lazily; a configuration problem rejects the dispatch
 * (500, GitHub may redeliver) without logging any value.
 */
export function getWebhookDispatch(): WebhookDispatch {
  return (event, payload, deliveryId) => {
    const runtime = getRuntime();
    return createWebhookDispatch({
      sync: runtime.sync,
      installationId: runtime.loaded.env.githubAppInstallationId,
      tasks: webhookTasks(),
    })(event, payload, deliveryId);
  };
}
