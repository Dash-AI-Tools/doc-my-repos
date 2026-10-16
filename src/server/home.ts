import "server-only";

import { ConfigError } from "./config/load";
import { describeDbError, type Db } from "./db/client";
import { listRepos, type RepoSummary } from "./queries";
import { getRuntime } from "./runtime";
import { logger, type LogFn } from "./log";

/**
 * Data for the home page (task 9.2). Reads only through the shared query layer; never GitHub.
 *
 * Failure policy. The home page is the first thing an operator opens after a deploy, so the two
 * expected failures render an in-page error state (the layout and header stay, the response is
 * HTTP 200 because Next.js cannot set a status from a page without throwing):
 * - the runtime cannot be built (`ConfigError`: missing or invalid environment or config file),
 * - the database cannot be reached or refuses the query (a SQLSTATE, an OS error code such as
 *   `ECONNREFUSED`, or a connect timeout).
 * Anything else is a bug and is rethrown, so the `error.tsx` boundary shows the generic error page.
 *
 * What is logged is a fixed message plus the error KIND (`ConfigError`, `database error
 * (ECONNREFUSED)`), never the error object, its message, stack or any connection detail: driver
 * errors can name the host, user and database.
 */

export type HomeData =
  | {
      readonly status: "ok";
      /** Starred repositories in the admin-set order (position, then id). */
      readonly starred: readonly RepoSummary[];
      /** Every other visible repository, in the order `listRepos` returns (owner, then name). */
      readonly repos: readonly RepoSummary[];
      /** When the data was read; pages format "x minutes ago" against this, not their own clock. */
      readonly loadedAt: Date;
    }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface HomeDeps {
  /** The database to read. Default: the shared runtime's. May throw `ConfigError`. */
  readonly db?: () => Db;
  readonly now?: () => Date;
  /** Structured log (fixed event names, safe fields only). Default: `logger.error`. */
  readonly log?: LogFn;
}

const UNKNOWN_DB_ERROR = describeDbError(undefined);

/**
 * The kind of an EXPECTED failure (safe to log), or null when the error is unexpected and must
 * propagate.
 */
export function expectedFailureKind(error: unknown): string | null {
  if (error instanceof ConfigError) return "ConfigError";
  const kind = describeDbError(error);
  return kind === UNKNOWN_DB_ERROR ? null : kind;
}

export async function loadHome(deps: HomeDeps = {}): Promise<HomeData> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db ?? (() => getRuntime().db.db);
  try {
    // Visibility is already applied by `listRepos`, so a blocked starred repo never gets here.
    const all = await listRepos(db());
    const starred = all
      .filter((r) => r.isStarred)
      .sort((a, b) => (a.starPosition ?? 0) - (b.starPosition ?? 0) || a.id - b.id);
    const repos = all.filter((r) => !r.isStarred);
    return { status: "ok", starred, repos, loadedAt: now() };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("home.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}
