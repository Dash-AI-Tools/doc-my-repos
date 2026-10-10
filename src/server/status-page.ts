import "server-only";

import type { Db } from "./db/client";
import { expectedFailureKind } from "./home";
import { getSyncStatus, type QueryOptions, type SyncStatus } from "./queries";
import { getRuntime } from "./runtime";

/**
 * Data for the `/status` page (task 12.2): the last sync run and every visible repository's sync
 * state, read through the shared query layer (`getSyncStatus`, visibility-filtered); never
 * GitHub. Same failure policy as the home page: an unusable configuration or an unreachable
 * database is an in-page error state with a fixed log line naming only the error kind; anything
 * else propagates to `error.tsx`.
 */

export type StatusPageData =
  | { readonly status: "ok"; readonly sync: SyncStatus; readonly loadedAt: Date }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface StatusPageDeps {
  /** The database to read. Default: the shared runtime's. May throw `ConfigError`. */
  readonly db?: () => Db;
  readonly now?: () => Date;
  /** Receives a fixed message only. Default: `console.error`. */
  readonly log?: (message: string) => void;
  /** Query options (tests swap the visibility filter). */
  readonly options?: QueryOptions;
}

export async function loadStatusPage(deps: StatusPageDeps = {}): Promise<StatusPageData> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.error(message));
  const db = deps.db ?? (() => getRuntime().db.db);
  try {
    const sync = await getSyncStatus(db(), {}, deps.options);
    return { status: "ok", sync, loadedAt: now() };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log(`[status] could not load the sync status: ${kind}`);
    return { status: "error", loadedAt: now() };
  }
}
