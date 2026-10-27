import "server-only";

import { getAskState, type AskState } from "./ask/settings";
import type { WorkspaceStatusInput } from "@docmyrepos/core/internal/workspace-status";
import { currentWorkspaceState } from "./workspace-state";
import type { DbSource } from "./db/client";
import { expectedFailureKind } from "./home";
import { getSyncStatus, type QueryOptions, type SyncStatus } from "./queries";
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
      /** Null when the settings could not be read; the section is then left out. */
      readonly workspace: WorkspaceStatusInput | null;
      readonly loadedAt: Date;
    }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface StatusPageDeps {
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
  readonly db: DbSource;
  readonly now?: () => Date;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
  /** Query options (tests swap the visibility filter). */
  readonly options?: QueryOptions;
  /** Where Ask stands. Default: the stored choice plus the environment (never throws). */
  readonly askState?: () => Promise<AskState>;
  /** What is missing or unreadable in the workspace. Default: the current workspace. */
  readonly workspaceState?: () => Promise<WorkspaceStatusInput>;
}

export async function loadStatusPage(deps: StatusPageDeps): Promise<StatusPageData> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db;
  try {
    const sync = await getSyncStatus(await db(), {}, deps.options);
    const ask = await (deps.askState ?? (async () => getAskState(await deps.db())))();
    const workspace = await (deps.workspaceState ?? currentWorkspaceState)().catch(() => null);
    return { status: "ok", sync, ask, workspace, loadedAt: now() };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("status_page.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}
