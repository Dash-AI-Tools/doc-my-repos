import "server-only";

import { ConfigError } from "./config/errors";
import { describeDbError, type Db, getDb } from "./db/client";
import { listFolders, listRepos, type FolderSummary, type RepoSummary } from "./queries";
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

/** A folder with the repositories to show under it. */
export interface HomeFolder {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly repos: readonly RepoSummary[];
}

export interface HomeTab {
  readonly id: number;
  readonly name: string;
}

export type HomeData =
  | {
      readonly status: "ok";
      /** Starred repositories in the admin-set order (position, then id). */
      readonly starred: readonly RepoSummary[];
      /**
       * All view: folders with at least one visible, unstarred repository, by name, each with those
       * repositories. Empty when no folder is in use.
       */
      readonly folders: readonly HomeFolder[];
      /** All view: every other visible repository (in no folder), owner then name. */
      readonly repos: readonly RepoSummary[];
      /** Starred folders that have a visible repository, in the admin-set order. */
      readonly tabs: readonly HomeTab[];
      /**
       * The selected folder tab with all its visible repositories (starred ones included), or null
       * for the All view (also when the requested folder is not a tab).
       */
      readonly folder: HomeFolder | null;
      /** When the data was read; pages format "x minutes ago" against this, not their own clock. */
      readonly loadedAt: Date;
    }
  | { readonly status: "error"; readonly loadedAt: Date };

export interface HomeDeps {
  /** The database to read. Default: the shared handle's. May throw `ConfigError`. */
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

/** Name order for folder sections: case-insensitive byte order, then id. */
const byName = (a: HomeTab, b: HomeTab): number => {
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a.id - b.id;
};

/**
 * Splits the visible repositories by folder. Folders only matter when a visible repository is in
 * them, which is how blocking hides a folder without a second visibility rule.
 */
export function groupHome(
  all: readonly RepoSummary[],
  folders: readonly FolderSummary[],
  folderId?: number,
): Pick<HomeData & { status: "ok" }, "starred" | "folders" | "repos" | "tabs" | "folder"> {
  const starred = all
    .filter((r) => r.isStarred)
    .sort((a, b) => (a.starPosition ?? 0) - (b.starPosition ?? 0) || a.id - b.id);
  const inFolder = (f: FolderSummary) => all.filter((r) => r.folderId === f.id);
  const used = folders.filter((f) => inFolder(f).length > 0);
  const toHome = (f: FolderSummary, repos: readonly RepoSummary[]): HomeFolder => ({
    id: f.id,
    name: f.name,
    description: f.description,
    repos,
  });
  const sections = used
    .map((f) =>
      toHome(
        f,
        inFolder(f).filter((r) => !r.isStarred),
      ),
    )
    .filter((f) => f.repos.length > 0)
    .sort((a, b) => byName(a, b));
  const tabFolders = used.filter((f) => f.isStarred);
  const selected = tabFolders.find((f) => f.id === folderId);
  return {
    starred,
    folders: sections,
    repos: all.filter((r) => !r.isStarred && r.folderId === null),
    tabs: tabFolders.map((f) => ({ id: f.id, name: f.name })),
    folder: selected ? toHome(selected, inFolder(selected)) : null,
  };
}

export async function loadHome(deps: HomeDeps = {}, folderId?: number): Promise<HomeData> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger.error;
  const db = deps.db ?? (() => getDb().db);
  try {
    // Visibility is already applied by `listRepos`, so a blocked starred repo never gets here.
    const all = await listRepos(db());
    const folders = await listFolders(db());
    return { status: "ok", ...groupHome(all, folders, folderId), loadedAt: now() };
  } catch (error) {
    const kind = expectedFailureKind(error);
    if (kind === null) throw error;
    log("home.load_failed", { reason: kind });
    return { status: "error", loadedAt: now() };
  }
}
