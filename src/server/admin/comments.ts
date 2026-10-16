import "server-only";

import {
  excerptOf,
  type ModerationData,
  type ModerationFilters,
  type ModerationRow,
  type ModerationState,
  MODERATION_STATES,
} from "@/lib/comments-moderation";
import { docUrl, repoUrl } from "@/lib/routes";
import { requireAdmin } from "@/server/auth/current-user";
import { getDb, type Db } from "@/server/db/client";
import { logger } from "@/server/log";
import {
  getCommentStates,
  getRepo,
  listCommentsForModeration,
  isCommentCursor,
} from "@/server/queries";
import { allowAllRepos } from "@/server/queries/visibility";
import { getRuntime } from "@/server/runtime";

/**
 * Data for the admin Comments page (document-comments task 5.1). Admin only: it asks
 * `requireAdmin` first and passes `allowAllRepos` explicitly so blocked repositories and orphans
 * are included. Independent of `comments.enabled` (the page still lists and purges when off).
 */

type Raw = Readonly<Record<string, string | string[] | undefined>>;

export interface ModerationDeps {
  readonly db?: () => Db;
  readonly enabled?: () => boolean;
  readonly admin?: (db: Db) => Promise<unknown>;
  readonly now?: () => Date;
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Reads the `state`, `repo` and `cursor` query values; anything malformed is ignored. */
export function parseModerationFilters(raw: Raw): ModerationFilters {
  const state = first(raw.state);
  const repo = first(raw.repo);
  const cursor = first(raw.cursor);
  return {
    state: MODERATION_STATES.includes(state as ModerationState) ? (state as ModerationState) : null,
    githubRepoId: repo !== undefined && /^[1-9]\d{0,14}$/.test(repo) ? Number(repo) : null,
    cursor: cursor !== undefined && isCommentCursor(cursor) ? cursor : null,
  };
}

function defaultEnabled(): boolean {
  return getRuntime().loaded.config.comments.enabled;
}

export async function loadModeration(raw: Raw, deps: ModerationDeps = {}): Promise<ModerationData> {
  const db = (deps.db ?? (() => getDb().db))();
  await (deps.admin ?? ((d: Db) => requireAdmin(d)))(db);
  const filters = parseModerationFilters(raw);
  try {
    let enabled = true;
    try {
      enabled = (deps.enabled ?? defaultEnabled)();
    } catch {
      // A configuration problem must not lock the admin out of purging.
    }
    const trusted = { visibility: allowAllRepos };
    const page = await listCommentsForModeration(
      db,
      {
        state: filters.state ?? undefined,
        githubRepoId: filters.githubRepoId ?? undefined,
        cursor: filters.cursor,
      },
      trusted,
    );

    const docsFolders = new Map<string, string | null>();
    for (const item of page.items) {
      if (item.state === "orphaned" || item.owner === null || item.name === null) continue;
      const key = `${item.owner}/${item.name}`;
      if (docsFolders.has(key)) continue;
      const repo = await getRepo(db, item.owner, item.name, trusted);
      docsFolders.set(key, repo?.docsPath ?? null);
    }
    const groupCounts = new Map<string, number>();
    for (const item of page.items) {
      if (item.state !== "orphaned") continue;
      const key = `${item.githubRepoId}\n${item.path}`;
      if (groupCounts.has(key)) continue;
      const states = await getCommentStates(
        db,
        { githubRepoId: item.githubRepoId, path: item.path },
        trusted,
      );
      groupCounts.set(key, states.length);
    }

    const rows: ModerationRow[] = page.items.map((item) => {
      const hasRepo = item.owner !== null && item.name !== null;
      const label = hasRepo ? `${item.owner}/${item.name}` : null;
      const docHref =
        hasRepo && item.state !== "orphaned" && label !== null
          ? docUrl(item.owner!, item.name!, item.path, docsFolders.get(label))
          : null;
      return {
        id: item.id,
        isReply: item.parentId !== null,
        state: item.state,
        githubRepoId: item.githubRepoId,
        path: item.path,
        repoLabel: label,
        repoHref: hasRepo ? repoUrl(item.owner!, item.name!) : null,
        docHref,
        authorLabel: item.authorLabel,
        authorEmail: item.authorEmail,
        asOrg: item.asOrg,
        excerpt: excerptOf(item.body),
        createdAt: item.createdAt.toISOString(),
        editedAt: item.editedAt === null ? null : item.editedAt.toISOString(),
        deleted: item.deleted,
        deletedByAdmin: item.deletedByAdmin,
        groupCount:
          item.state === "orphaned"
            ? (groupCounts.get(`${item.githubRepoId}\n${item.path}`) ?? null)
            : null,
      };
    });
    return {
      status: "ready",
      enabled,
      filters,
      rows,
      nextCursor: page.nextCursor,
      now: (deps.now ?? (() => new Date()))().toISOString(),
    };
  } catch {
    try {
      logger.error("comments.moderation.failed", { action: "moderation_page" });
    } catch {
      // ignore
    }
    return { status: "unavailable" };
  }
}
