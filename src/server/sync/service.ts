import "server-only";

import { readSyncSecret, type EnvSource } from "../config/env";
import { getWorkspace, requireGitHub, type WorkspaceOptions } from "../workspace";
import { requestSync, syncAll } from "./engine";
import { fromRequestSync, type ManualSyncService } from "./manual-sync";

/**
 * Binds the manual sync handler to the real runtime (task 6.1). Kept apart from `route.ts`
 * because a Next.js route file may export only route fields, and so tests can replace it.
 */

/** The configured sync secret from the environment, or null. Reads no file and opens no connection. */
export function readConfiguredSyncSecret(env: EnvSource = process.env): string | null {
  return readSyncSecret(env)?.reveal() ?? null;
}

/**
 * The sync service over the current workspace settings, re-checked on every call so a saved change
 * applies to the next sync. Rejects with `NotConfiguredError` (setting names only) when the GitHub
 * settings are incomplete. `options` is for tests (environment, fetch, database).
 *
 * A single-repo sync goes through `requestSync` (task 6.4): a repo another sync holds answers
 * `coalesced` at once, and a request for a never-synced repo whose first sync is running elsewhere
 * answers `busy` instead of waiting (`queueWaitMs: 0`).
 */
export async function getSyncService(options: WorkspaceOptions = {}): Promise<ManualSyncService> {
  const { sync } = requireGitHub(await getWorkspace({ ...options, fresh: true }));
  return {
    syncAll: (options) => syncAll(sync, options),
    syncOne: async (target, options) =>
      fromRequestSync(await requestSync(sync, target, { ...options, queueWaitMs: 0 })),
  };
}
