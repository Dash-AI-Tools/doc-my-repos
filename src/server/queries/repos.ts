import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { parseSyncWarnings, type SyncWarningView } from "../../lib/sync-warnings";
import type { Db } from "../db/client";
import { codeOwnerKinds, codeOwners, documents, repos, type CodeOwnerRef } from "../db/schema";
import {
  isLookupText,
  MAX_NAME_CHARS,
  ownerNameMatch,
  pickRepoMatch,
  repoCondition,
  type RepoRef,
} from "./repo-ref";
import { visibleRepos, type QueryOptions } from "./visibility";

/**
 * Repository reads for the portal (task 9.1): the home grid, the repository space and its code
 * owners. Every query filters `repos` with `visibleRepos(options)`; code owners and document
 * counts are reached only through a join or correlation with that filtered `repos` row.
 */

export type RepoVisibility = "public" | "private";
export type RepoSyncStatus = "pending" | "ok" | "error";

/** A repository card on the home page. */
export interface RepoSummary {
  readonly id: number;
  /** Canonical spelling, as stored. */
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly htmlUrl: string;
  readonly visibility: RepoVisibility;
  /** False when an admin blocked the repo (hidden everywhere, content kept). */
  readonly isAllowed: boolean;
  /** Place in the admin-set starred order; null when not starred. */
  readonly starPosition: number | null;
  /** Starred by an admin (portal-wide); derived from `starPosition`. */
  readonly isStarred: boolean;
  readonly isOkf: boolean;
  readonly okfVersion: string | null;
  /** `error` when the last sync failed; previously stored content is still served. */
  readonly syncStatus: RepoSyncStatus;
  /**
   * Why the last sync failed. Safe to show: the sync writes only fixed texts here (built by
   * `describeSyncError` or the installation messages), never raw errors; clipped to
   * `MAX_SYNC_ERROR_CHARS` as a second guard.
   */
  readonly syncError: string | null;
  readonly lastSyncedAt: Date | null;
  /** Stored documents, reserved `index.md`/`log.md` included (each is a page). */
  readonly docCount: number;
}

export interface RepoReadme {
  /** Repo-relative path (`README.md`). */
  readonly path: string;
  /** Raw Markdown as stored; render with `renderMarkdown` and `path: 'README.md'`. */
  readonly markdown: string;
  readonly sha: string | null;
}

/** One CODEOWNERS rule in file order. Group by owner at render time (design decision 12). */
export interface CodeOwnerRule {
  readonly position: number;
  readonly pattern: string;
  /** Handles as authored, with `@` (`@alice`, `@my-org/docs-team`) or an email. */
  readonly owners: readonly CodeOwnerRef[];
  /** Which CODEOWNERS file the rule came from. */
  readonly sourcePath: string;
}

/** A repository space (`/<owner>/<repo>`). */
export interface RepoDetail extends RepoSummary {
  readonly githubId: number;
  /** Empty for an empty repository. */
  readonly defaultBranch: string;
  /** Docs folder in use (`docs`), null when the repository has none. */
  readonly docsPath: string | null;
  /** Null when the repository has no README. */
  readonly readme: RepoReadme | null;
  readonly codeownersPath: string | null;
  /** Rules in file order; empty when there is no CODEOWNERS file or it has no rules. */
  readonly codeOwners: readonly CodeOwnerRule[];
  /**
   * Files the last content sync left out (document cap, size cap, rejected), task 12.3; empty when
   * none. Fixed texts and repo-relative paths, bounded.
   */
  readonly syncWarnings: readonly SyncWarningView[];
}

export interface ListReposArgs {
  /** At most this many repositories (1 to `MAX_LIST_LIMIT`); all when absent or invalid. */
  readonly limit?: number;
  /** Skip this many (a non-negative integer); 0 when absent or invalid. */
  readonly offset?: number;
}

export const MAX_LIST_LIMIT = 1000;
export const MAX_SYNC_ERROR_CHARS = 500;

// Correlated count. Drizzle renders columns unqualified inside a selected `sql` fragment, where
// `repo_id = id` would compare two columns of `documents`, so the names are spelled out here.
const docCount = sql<number>`(select count(*)::int from ${documents} as "dc" where "dc"."repo_id" = "repos"."id")`;

const summaryColumns = {
  id: repos.id,
  owner: repos.owner,
  name: repos.name,
  description: repos.description,
  htmlUrl: repos.htmlUrl,
  visibility: repos.visibility,
  isAllowed: repos.isAllowed,
  starPosition: repos.starPosition,
  isOkf: repos.isOkf,
  okfVersion: repos.okfVersion,
  syncStatus: repos.syncStatus,
  syncError: repos.syncError,
  lastSyncedAt: repos.lastSyncedAt,
  docCount,
};

type SummaryRow = {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  visibility: RepoVisibility;
  isAllowed: boolean;
  starPosition: number | null;
  isOkf: boolean;
  okfVersion: string | null;
  syncStatus: RepoSyncStatus;
  syncError: string | null;
  lastSyncedAt: Date | null;
  docCount: number;
};

function clip(value: string | null, max: number): string | null {
  return value === null || value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function toSummary(row: SummaryRow): RepoSummary {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    description: row.description,
    htmlUrl: row.htmlUrl,
    visibility: row.visibility,
    isAllowed: row.isAllowed,
    starPosition: row.starPosition,
    isStarred: row.starPosition !== null,
    isOkf: row.isOkf,
    okfVersion: row.okfVersion,
    syncStatus: row.syncStatus,
    syncError: clip(row.syncError, MAX_SYNC_ERROR_CHARS),
    lastSyncedAt: row.lastSyncedAt,
    docCount: Number(row.docCount) || 0,
  };
}

function pageInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/**
 * Repositories for the home grid, ordered by owner then name (case-insensitive, then exact
 * spelling, then id, so the order is total and pages never overlap). Spec-silent choices: the
 * search bar on the home page is the global document search (group 10), not a repository filter,
 * so there is no name filter here; an empty list is the "nothing synced yet" state.
 */
export async function listRepos(
  db: Db,
  args: ListReposArgs = {},
  options: QueryOptions = {},
): Promise<RepoSummary[]> {
  const limit = pageInt(args.limit, 1, MAX_LIST_LIMIT);
  const offset = pageInt(args.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const base = db
    .select(summaryColumns)
    .from(repos)
    .where(visibleRepos(options))
    // Byte order ("C") rather than the database's collation, so the order is the same on every
    // server: case-insensitive first, then exact spelling, then id.
    .orderBy(
      sql`lower(${repos.owner}) collate "C"`,
      sql`lower(${repos.name}) collate "C"`,
      sql`${repos.owner} collate "C"`,
      sql`${repos.name} collate "C"`,
      asc(repos.id),
    )
    .offset(offset);
  const rows = limit === null ? await base : await base.limit(limit);
  return rows.map(toSummary);
}

/**
 * The repository space for `owner/name` (case-insensitive; the stored spelling is returned), or
 * null when it is not synced, hidden by the visibility filter, or ambiguous by case.
 */
export async function getRepo(
  db: Db,
  owner: string,
  name: string,
  options: QueryOptions = {},
): Promise<RepoDetail | null> {
  if (!isLookupText(owner, MAX_NAME_CHARS) || !isLookupText(name, MAX_NAME_CHARS)) return null;
  const match = ownerNameMatch(owner, name);
  const rows = await db
    .select({
      ...summaryColumns,
      githubId: repos.githubId,
      defaultBranch: repos.defaultBranch,
      docsPath: repos.docsPath,
      readmePath: repos.readmePath,
      readmeMarkdown: repos.readmeMarkdown,
      readmeSha: repos.readmeSha,
      codeownersPath: repos.codeownersPath,
      syncWarnings: repos.syncWarnings,
      exact: match.exact,
    })
    .from(repos)
    .where(and(visibleRepos(options), match.where))
    .orderBy(sql`${match.exact} desc`, repos.id)
    .limit(2);
  const row = pickRepoMatch(rows);
  if (row === null) return null;

  const rules = await listCodeOwners(db, { id: row.id }, options);
  return {
    ...toSummary(row),
    githubId: row.githubId,
    defaultBranch: row.defaultBranch,
    docsPath: row.docsPath,
    readme:
      row.readmeMarkdown === null
        ? null
        : { path: row.readmePath ?? "README.md", markdown: row.readmeMarkdown, sha: row.readmeSha },
    codeownersPath: row.codeownersPath,
    codeOwners: rules,
    syncWarnings: parseSyncWarnings(row.syncWarnings),
  };
}

const OWNER_KINDS: ReadonlySet<string> = new Set(codeOwnerKinds);

/** The stored owners JSONB as a clean list: malformed entries are dropped, never thrown on. */
function parseOwners(value: unknown): CodeOwnerRef[] {
  if (!Array.isArray(value)) return [];
  const out: CodeOwnerRef[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { handle, kind } = item as { handle?: unknown; kind?: unknown };
    if (typeof handle !== "string" || handle === "") continue;
    if (typeof kind !== "string" || !OWNER_KINDS.has(kind)) continue;
    out.push({ handle, kind: kind as CodeOwnerRef["kind"] });
  }
  return out;
}

/** CODEOWNERS rules of a visible repository in file order; empty when none or hidden. */
export async function listCodeOwners(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<CodeOwnerRule[]> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return [];
  const rows = await db
    .select({
      position: codeOwners.position,
      pattern: codeOwners.pattern,
      owners: codeOwners.owners,
      sourcePath: codeOwners.sourcePath,
    })
    .from(codeOwners)
    .innerJoin(repos, eq(repos.id, codeOwners.repoId))
    .where(and(visibleRepos(options), where))
    .orderBy(asc(codeOwners.position));
  return rows.map((r) => ({
    position: r.position,
    pattern: r.pattern,
    owners: parseOwners(r.owners),
    sourcePath: r.sourcePath,
  }));
}
