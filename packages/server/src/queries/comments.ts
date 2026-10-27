import "server-only";

import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { docComments, documents, repos, users } from "../db/schema";
import { isLookupText, MAX_PATH_CHARS, repoCondition, type RepoRef } from "./repo-ref";
import { allowAllRepos, visibleRepos, type QueryOptions } from "./visibility";

/**
 * Comment reads (document-comments design decisions 1 and 2). Comments are keyed by the GitHub
 * repository id and the document path, with no foreign key to `repos` or `documents`, so every
 * read joins `repos` on `github_id` (with `visibleRepos`) and `documents` on `(repo_id, path)`:
 * a hidden repository or a missing document yields nothing, and the comments come back with the
 * repository or the path. Nothing here reads GitHub.
 *
 * Deleted comments have their text scrubbed at write time. Reads turn them into placeholders
 * (`deleted: true`, empty body, no author), and a deleted comment with no live reply is not
 * returned at all (readers) or is classified `deleted` / `orphaned` (moderation).
 *
 * The moderation reads (`listCommentsForModeration`, `getCommentStates`, and `getCommentTarget`
 * with `includeOrphans`) include comments whose repository or document is gone only when the
 * caller passes `visibility: allowAllRepos` explicitly, which trusted admin code does after
 * `requireAdmin`. With any other filter they see exactly what the readers see.
 */

/** Comments per page of a document (roots; their replies come with them). */
export const COMMENTS_PAGE_SIZE = 50;
/** Most rows per page of the moderation list. */
export const MODERATION_PAGE_MAX = 100;
/** Most rows `getCommentStates` returns. */
export const COMMENT_STATES_MAX = 2000;

/** One comment as readers see it. Deleted comments carry no text, author or markers. */
export interface CommentView {
  readonly id: number;
  /** The thread root this is a reply to, or null for a thread's first comment. */
  readonly parentId: number | null;
  /** Null for a deleted comment and after the author's account was removed. */
  readonly authorId: number | null;
  /** The name the author had when posting; empty for a deleted comment. */
  readonly authorLabel: string;
  /** The full email, only when the caller asked for it (admins); otherwise null. */
  readonly authorEmail: string | null;
  readonly asOrg: boolean;
  /** Empty for a deleted comment. */
  readonly body: string;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deleted: boolean;
  /** Set on thread roots only. */
  readonly resolvedAt: Date | null;
}

export interface CommentThread {
  readonly root: CommentView;
  /** Live replies, oldest first. */
  readonly replies: readonly CommentView[];
}

export interface DocCommentsPage {
  readonly threads: readonly CommentThread[];
  /** Pass as `cursor` for the next page, or null at the end. */
  readonly nextCursor: string | null;
}

export interface ListDocCommentsArgs {
  readonly repo: RepoRef;
  /** The stored document path. */
  readonly path: string;
  readonly cursor?: string | null;
  /** 1 to 50, default 50. */
  readonly limit?: number;
  /** Include authors' full emails (admins only). */
  readonly includeEmail?: boolean;
}

const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)\|(\d{1,15})$/;

/** True for a cursor produced by these queries. */
export function isCommentCursor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && CURSOR.test(value);
}

function parseCursor(value: string | null | undefined): { at: string; id: number } | null | "bad" {
  if (value === undefined || value === null || value === "") return null;
  const m = isCommentCursor(value) ? CURSOR.exec(value) : null;
  if (m === null) return "bad";
  return { at: m[1]!, id: Number(m[2]) };
}

const c = docComments;

/** Microsecond-exact text of `created_at`, so a cursor never skips or repeats rows. */
const cursorAt = sql<string>`to_char(${c.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const hasLiveReply = sql<boolean>`exists (select 1 from doc_comments as replies where replies.parent_id = ${c.id} and replies.deleted_at is null)`;

const viewColumns = {
  id: c.id,
  parentId: c.parentId,
  authorId: c.authorId,
  authorLabel: c.authorLabel,
  asOrg: c.asOrg,
  body: c.body,
  createdAt: c.createdAt,
  editedAt: c.editedAt,
  deletedAt: c.deletedAt,
  resolvedAt: c.resolvedAt,
  cursorAt,
};

type ViewRow = {
  id: number;
  parentId: number | null;
  authorId: number | null;
  authorLabel: string;
  asOrg: boolean;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  resolvedAt: Date | null;
  authorEmail: string | null;
};

function toView(row: ViewRow): CommentView {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    parentId: row.parentId,
    authorId: deleted ? null : row.authorId,
    authorLabel: deleted ? "" : row.authorLabel,
    authorEmail: deleted ? null : row.authorEmail,
    asOrg: deleted ? false : row.asOrg,
    body: deleted ? "" : row.body,
    createdAt: row.createdAt,
    editedAt: deleted ? null : row.editedAt,
    deleted,
    resolvedAt: row.resolvedAt,
  };
}

const emailColumn = (includeEmail: boolean) =>
  includeEmail ? users.email : sql<string | null>`null`;

/** Live replies of the given roots, oldest first, as views grouped by root id. */
async function loadReplies(
  db: Db,
  rootIds: readonly number[],
  where: SQL,
  includeEmail: boolean,
): Promise<Map<number, CommentView[]>> {
  const out = new Map<number, CommentView[]>();
  if (rootIds.length === 0) return out;
  const rows = await db
    .select({ ...viewColumns, authorEmail: emailColumn(includeEmail) })
    .from(c)
    .innerJoin(repos, eq(repos.githubId, c.githubRepoId))
    .innerJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .leftJoin(users, eq(users.id, c.authorId))
    .where(and(where, inArray(c.parentId, [...rootIds]), isNull(c.deletedAt)))
    .orderBy(asc(c.createdAt), asc(c.id));
  for (const row of rows) {
    if (row.parentId === null) continue;
    const list = out.get(row.parentId) ?? [];
    list.push(toView(row));
    out.set(row.parentId, list);
  }
  return out;
}

/** A thread root is shown when it is live or a deleted placeholder that still has live replies. */
const rootShown = or(isNull(c.deletedAt), hasLiveReply) as SQL;

/**
 * Threads of a document, oldest first, 50 roots per page with all of their live replies. Deleted
 * roots with no live reply are dropped. Empty when the repository is unknown or hidden, the
 * document does not exist (an orphan), or the cursor is not one these queries produced.
 */
export async function listDocComments(
  db: Db,
  args: ListDocCommentsArgs,
  options: QueryOptions = {},
): Promise<DocCommentsPage> {
  const empty: DocCommentsPage = { threads: [], nextCursor: null };
  if (!isLookupText(args.path, MAX_PATH_CHARS)) return empty;
  const cursor = parseCursor(args.cursor);
  if (cursor === "bad") return empty;
  const repoWhere = await repoCondition(db, args.repo, options);
  if (repoWhere === null) return empty;
  const limit = Math.min(
    Math.max(Math.trunc(args.limit ?? COMMENTS_PAGE_SIZE) || 1, 1),
    COMMENTS_PAGE_SIZE,
  );
  const includeEmail = args.includeEmail === true;
  const scope = and(visibleRepos(options), repoWhere, eq(c.path, args.path)) as SQL;

  const rows = await db
    .select({ ...viewColumns, authorEmail: emailColumn(includeEmail) })
    .from(c)
    .innerJoin(repos, eq(repos.githubId, c.githubRepoId))
    .innerJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .leftJoin(users, eq(users.id, c.authorId))
    .where(
      and(
        scope,
        isNull(c.parentId),
        rootShown,
        cursor === null
          ? undefined
          : sql`(${c.createdAt}, ${c.id}) > (${cursor.at}::timestamptz, ${cursor.id}::bigint)`,
      ),
    )
    .orderBy(asc(c.createdAt), asc(c.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? `${last.cursorAt}|${last.id}` : null;
  const replies = await loadReplies(
    db,
    page.map((r) => r.id),
    scope,
    includeEmail,
  );
  return {
    threads: page.map((r) => ({ root: toView(r), replies: replies.get(r.id) ?? [] })),
    nextCursor,
  };
}

export interface DocCommentCounts {
  /** Live comments (roots and replies); deleted placeholders are not counted. */
  readonly comments: number;
  /** Shown threads that are not resolved. */
  readonly openThreads: number;
}

/** Counts for the document header link. Zeros when the document is hidden or missing. */
export async function countDocComments(
  db: Db,
  args: { readonly repo: RepoRef; readonly path: string },
  options: QueryOptions = {},
): Promise<DocCommentCounts> {
  const zero = { comments: 0, openThreads: 0 };
  if (!isLookupText(args.path, MAX_PATH_CHARS)) return zero;
  const repoWhere = await repoCondition(db, args.repo, options);
  if (repoWhere === null) return zero;
  const [row] = await db
    .select({
      comments: sql<number>`count(*) filter (where ${c.deletedAt} is null)::int`,
      open: sql<number>`count(*) filter (where ${c.parentId} is null and ${c.resolvedAt} is null and (${c.deletedAt} is null or ${hasLiveReply}))::int`,
    })
    .from(c)
    .innerJoin(repos, eq(repos.githubId, c.githubRepoId))
    .innerJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .where(and(visibleRepos(options), repoWhere, eq(c.path, args.path)));
  return { comments: Number(row?.comments ?? 0) || 0, openThreads: Number(row?.open ?? 0) || 0 };
}

/** A document comments can be written on: it exists in a repository the reader may see. */
export interface CommentDocument {
  readonly githubRepoId: number;
  readonly owner: string;
  readonly name: string;
  readonly path: string;
}

/**
 * The visible document at exactly `path`, or null (unknown, missing, or in a hidden repository).
 * Writers call this before every insert.
 */
export async function getCommentDocument(
  db: Db,
  args: { readonly repo: RepoRef; readonly path: string },
  options: QueryOptions = {},
): Promise<CommentDocument | null> {
  if (!isLookupText(args.path, MAX_PATH_CHARS)) return null;
  const repoWhere = await repoCondition(db, args.repo, options);
  if (repoWhere === null) return null;
  const [row] = await db
    .select({
      githubRepoId: repos.githubId,
      owner: repos.owner,
      name: repos.name,
      path: documents.path,
    })
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(and(visibleRepos(options), repoWhere, eq(documents.path, args.path)))
    .limit(1);
  return row ?? null;
}

export type CommentState = "live" | "deleted" | "orphaned" | "blocked";

/**
 * The class of a comment for moderation: `orphaned` (its repository row or document row is gone),
 * else `blocked` (repository not allowed), else `deleted` (text removed), else `live`.
 */
const stateExpr = sql<CommentState>`case
  when ${repos.id} is null or ${documents.id} is null then 'orphaned'
  when ${repos.isAllowed} = false then 'blocked'
  when ${c.deletedAt} is not null then 'deleted'
  else 'live' end`;

/**
 * The WHERE for reads over `comments left join repos left join documents`: what the visibility
 * filter shows, plus (only with `includeOrphans` and an explicit `allowAllRepos`) rows whose
 * repository or document no longer exists.
 */
function leftScope(options: QueryOptions, includeOrphans: boolean): SQL {
  if (includeOrphans && options.visibility === allowAllRepos) return sql`true`;
  return and(
    sql`${repos.id} is not null`,
    sql`${documents.id} is not null`,
    visibleRepos(options),
  ) as SQL;
}

export interface CommentTarget {
  readonly id: number;
  readonly githubRepoId: number;
  readonly path: string;
  /** Null for a thread root. */
  readonly parentId: number | null;
  /** The thread root's id: the comment itself for a root. */
  readonly rootId: number;
  readonly authorId: number | null;
  readonly authorLabel: string;
  readonly asOrg: boolean;
  readonly deleted: boolean;
  readonly hasLiveReplies: boolean;
  readonly resolved: boolean;
  readonly state: CommentState;
  /** Null when the repository row is gone (orphans, admin reads only). */
  readonly owner: string | null;
  readonly name: string | null;
}

export interface CommentTargetOptions extends QueryOptions {
  /** Trusted admin code only, with `visibility: allowAllRepos`: also find orphaned comments. */
  readonly includeOrphans?: boolean;
}

/**
 * The comment `id` with what permission checks need, or null when it does not exist or its
 * document is not visible to the reader.
 */
export async function getCommentTarget(
  db: Db,
  id: number,
  options: CommentTargetOptions = {},
): Promise<CommentTarget | null> {
  if (!isRowId64(id)) return null;
  const [row] = await db
    .select({
      id: c.id,
      githubRepoId: c.githubRepoId,
      path: c.path,
      parentId: c.parentId,
      authorId: c.authorId,
      authorLabel: c.authorLabel,
      asOrg: c.asOrg,
      deletedAt: c.deletedAt,
      hasLiveReplies: hasLiveReply,
      resolvedAt: c.resolvedAt,
      state: stateExpr,
      owner: repos.owner,
      name: repos.name,
    })
    .from(c)
    .leftJoin(repos, eq(repos.githubId, c.githubRepoId))
    .leftJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .where(and(eq(c.id, id), leftScope(options, options.includeOrphans === true)))
    .limit(1);
  if (row === undefined) return null;
  return {
    id: row.id,
    githubRepoId: row.githubRepoId,
    path: row.path,
    parentId: row.parentId,
    rootId: row.parentId ?? row.id,
    authorId: row.authorId,
    authorLabel: row.authorLabel,
    asOrg: row.asOrg,
    deleted: row.deletedAt !== null,
    hasLiveReplies: row.hasLiveReplies,
    resolved: row.resolvedAt !== null,
    state: row.state,
    owner: row.owner,
    name: row.name,
  };
}

function isRowId64(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The thread whose root is `rootId`, or null when the root is hidden, missing, or a deleted
 * comment with no live reply. Used by writers to return the changed thread.
 */
export async function getCommentThread(
  db: Db,
  rootId: number,
  options: QueryOptions & { readonly includeEmail?: boolean } = {},
): Promise<CommentThread | null> {
  if (!isRowId64(rootId)) return null;
  const includeEmail = options.includeEmail === true;
  const scope = visibleRepos(options);
  const [row] = await db
    .select({ ...viewColumns, authorEmail: emailColumn(includeEmail) })
    .from(c)
    .innerJoin(repos, eq(repos.githubId, c.githubRepoId))
    .innerJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .leftJoin(users, eq(users.id, c.authorId))
    .where(and(scope, eq(c.id, rootId), isNull(c.parentId), rootShown))
    .limit(1);
  if (row === undefined) return null;
  const replies = await loadReplies(db, [row.id], scope, includeEmail);
  return { root: toView(row), replies: replies.get(row.id) ?? [] };
}

export interface ModerationComment {
  readonly id: number;
  readonly parentId: number | null;
  readonly githubRepoId: number;
  readonly path: string;
  /** Null when the repository row no longer exists. */
  readonly owner: string | null;
  readonly name: string | null;
  readonly authorId: number | null;
  readonly authorLabel: string;
  /** Null after the author's account was removed. */
  readonly authorEmail: string | null;
  readonly asOrg: boolean;
  /** Empty for a deleted comment. */
  readonly body: string;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deleted: boolean;
  readonly deletedByAdmin: boolean;
  readonly state: CommentState;
}

export interface ListCommentsForModerationArgs {
  readonly state?: CommentState;
  /** Only comments of this GitHub repository id (also finds those of a removed repository). */
  readonly githubRepoId?: number;
  readonly cursor?: string | null;
  /** 1 to 100, default 50. */
  readonly limit?: number;
}

export interface ModerationPage {
  readonly items: readonly ModerationComment[];
  readonly nextCursor: string | null;
}

function stateCondition(state: CommentState | undefined): SQL | undefined {
  return state === undefined ? undefined : sql`${stateExpr} = ${state}`;
}

/**
 * Every comment, newest first, with the repository, author and state, for the admin Comments
 * page. Trusted admin callers pass `visibility: allowAllRepos` (after `requireAdmin`) to include
 * blocked repositories and orphans; any other filter returns only what readers could see.
 */
export async function listCommentsForModeration(
  db: Db,
  args: ListCommentsForModerationArgs = {},
  options: QueryOptions = {},
): Promise<ModerationPage> {
  const empty: ModerationPage = { items: [], nextCursor: null };
  const cursor = parseCursor(args.cursor);
  if (cursor === "bad") return empty;
  if (args.githubRepoId !== undefined && !isRowId64(args.githubRepoId)) return empty;
  const limit = Math.min(
    Math.max(Math.trunc(args.limit ?? COMMENTS_PAGE_SIZE) || 1, 1),
    MODERATION_PAGE_MAX,
  );
  const rows = await db
    .select({
      id: c.id,
      parentId: c.parentId,
      githubRepoId: c.githubRepoId,
      path: c.path,
      owner: repos.owner,
      name: repos.name,
      authorId: c.authorId,
      authorLabel: c.authorLabel,
      authorEmail: users.email,
      asOrg: c.asOrg,
      body: c.body,
      createdAt: c.createdAt,
      editedAt: c.editedAt,
      deletedAt: c.deletedAt,
      deletedByAdmin: c.deletedByAdmin,
      state: stateExpr,
      cursorAt,
    })
    .from(c)
    .leftJoin(repos, eq(repos.githubId, c.githubRepoId))
    .leftJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .leftJoin(users, eq(users.id, c.authorId))
    .where(
      and(
        leftScope(options, true),
        stateCondition(args.state),
        args.githubRepoId === undefined ? undefined : eq(c.githubRepoId, args.githubRepoId),
        cursor === null
          ? undefined
          : sql`(${c.createdAt}, ${c.id}) < (${cursor.at}::timestamptz, ${cursor.id}::bigint)`,
      ),
    )
    .orderBy(desc(c.createdAt), desc(c.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      githubRepoId: r.githubRepoId,
      path: r.path,
      owner: r.owner,
      name: r.name,
      authorId: r.authorId,
      authorLabel: r.authorLabel,
      authorEmail: r.authorEmail,
      asOrg: r.asOrg,
      body: r.deletedAt !== null ? "" : r.body,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      deleted: r.deletedAt !== null,
      deletedByAdmin: r.deletedByAdmin,
      state: r.state,
    })),
    nextCursor: rows.length > limit && last !== undefined ? `${last.cursorAt}|${last.id}` : null,
  };
}

export type CommentSelector =
  { readonly ids: readonly number[] } | { readonly githubRepoId: number; readonly path: string };

export interface CommentStateRow {
  readonly id: number;
  readonly state: CommentState;
  readonly deleted: boolean;
  /** True when a live reply is attached (removing this comment would cascade to it). */
  readonly hasLiveReplies: boolean;
}

/**
 * The state of each selected comment (up to 2,000), for permanent removal: the caller removes
 * only orphaned comments and deleted ones without live replies. Same scope rule as
 * `listCommentsForModeration`.
 */
export async function getCommentStates(
  db: Db,
  selector: CommentSelector,
  options: QueryOptions = {},
): Promise<CommentStateRow[]> {
  let selected: SQL;
  if ("ids" in selector) {
    const ids = selector.ids.filter(isRowId64);
    if (ids.length === 0) return [];
    selected = inArray(c.id, ids);
  } else {
    if (!isRowId64(selector.githubRepoId) || !isLookupText(selector.path, MAX_PATH_CHARS)) {
      return [];
    }
    selected = and(eq(c.githubRepoId, selector.githubRepoId), eq(c.path, selector.path)) as SQL;
  }
  return db
    .select({
      id: c.id,
      state: stateExpr,
      deleted: sql<boolean>`${c.deletedAt} is not null`,
      hasLiveReplies: hasLiveReply,
    })
    .from(c)
    .leftJoin(repos, eq(repos.githubId, c.githubRepoId))
    .leftJoin(documents, and(eq(documents.repoId, repos.id), eq(documents.path, c.path)))
    .where(and(selected, leftScope(options, true)))
    .orderBy(asc(c.id))
    .limit(COMMENT_STATES_MAX);
}
