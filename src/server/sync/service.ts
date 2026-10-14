import "server-only";

import { readSyncSecret, type EnvSource } from "../config/env";
import { reloadRuntime, type RuntimeOptions } from "../runtime";
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
 * The sync service over a freshly re-read configuration (design: config is re-read on
 * `/api/sync`). The database pool is reused; see `reloadRuntime`. Throws `ConfigError` when the
 * configuration is invalid. `options` is for tests (environment, file reader, fetch, database).
 *
 * A single-repo sync goes through `requestSync` (task 6.4): a repo another sync holds answers
 * `coalesced` at once, and a request for a never-synced repo whose first sync is running elsewhere
 * answers `busy` instead of waiting (`queueWaitMs: 0`).
 */
export function getSyncService(options: RuntimeOptions = {}): ManualSyncService {
  const { sync } = reloadRuntime(options);
  return {
    syncAll: (options) => syncAll(sync, options),
    syncOne: async (target, options) =>
      fromRequestSync(await requestSync(sync, target, { ...options, queueWaitMs: 0 })),
  };
}
