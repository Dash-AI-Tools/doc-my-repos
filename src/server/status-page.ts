import "server-only";

import { getAskState, type AskState } from "./ask/settings";
import type { Db } from "./db/client";
import { expectedFailureKind } from "./home";
import { getSyncStatus, type QueryOptions, type SyncStatus } from "./queries";
import { getRuntime } from "./runtime";
import { logger, type LogFn } from "./log";

/**
 * Data for the `/status` page (task 12.2): the last sync run and every visible repository's sync
 * state, read through the shared query layer (`getSyncStatus`, visibility-filtered); never
 * GitHub. Same failure policy as the home page: an unusable configuration or an unreachable
 * database is an in-page error state with a fixed log line naming only the error kind; anything
 * else propagates to `error.tsx`.
 */

export type StatusPageData =
  | {
      readonly status: "ok";
      readonly sync: SyncStatus;
      readonly ask: AskState;
      readonly loadedAt: Date;
    }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface StatusPageDeps {
  /** The database to read. Default: the shared runtime's. May throw `ConfigError`. */
  readonly db?: () => Db;
  readonly now?: () => Date;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
  /** Query options (tests swap the visibility filter). */
  readonly options?: QueryOptions;
  /** Where Ask stands. Default: the stored choice plus the environment (never throws). */
  readonly askState?: () => Promise<AskState>;
}

export async function loadStatusPage(deps: StatusPageDeps = {}): Promise<StatusPageData> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db ?? (() => getRuntime().db.db);
  try {
    const sync = await getSyncStatus(db(), {}, deps.options);
    const ask = await (deps.askState ?? (() => getAskState()))();
    return { status: "ok", sync, ask, loadedAt: now() };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("status_page.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}
