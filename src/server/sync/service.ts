import "server-only";

import { readSyncSecret, type EnvSource } from "../config/env";
import { reloadRuntime, type RuntimeOptions } from "../runtime";
import { syncAll, syncOne } from "./engine";
import type { ManualSyncService } from "./manual-sync";

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
 */
export function getSyncService(options: RuntimeOptions = {}): ManualSyncService {
  const { sync } = reloadRuntime(options);
  return {
    syncAll: (options) => syncAll(sync, options),
    syncOne: (target, options) => syncOne(sync, target, options),
  };
}
