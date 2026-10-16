import "server-only";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { cleanComment, displayName, MAX_COMMENT_LENGTH } from "@/lib/comments";
import { requireAdmin, requireUser, type CurrentUser } from "../auth/current-user";
import { advisoryLockKey } from "../db/advisory-lock";
import { getDb, type Db } from "../db/client";
import { docComments } from "../db/schema";
import { logger, type Logger } from "../log";
import {
  getCommentDocument,
  getCommentStates,
  getCommentTarget,
  getCommentThread,
  type CommentTarget,
} from "../queries";
import { allowAllRepos, type QueryOptions } from "../queries/visibility";
import { requireSameOrigin } from "../same-origin";
import { commentsEnabled } from "../workspace";
import {
  failure,
  type CommentChange,
  type CommentFailure,
  type CommentResult,
  type PurgeResult,
} from "./results";

/**
 * Comment write handlers (document-comments tasks 2.3 and 2.4, design decisions 3, 4, 6 and 9).
 * Each takes the `Request` (and the `[id]` path segment as a string) and returns a structured
 * result; `commentResponse` (results.ts) turns it into the JSON response, so the routes are thin.
 *
 * Check order, the same for every handler, each step ending the request with its own status:
 *   1. feature flag (404)            2. session (401)             3. same-origin + JSON (403)
 *   4. body parse, zod strict (400)  5. document visible through the query layer (404)
 *   6. authorization (403)           7. limits under the per-document advisory lock (429, 409)
 *   8. clean the text (400)          9. write.
 *
 * Reads and writes of `doc_comments` rows by this module are its own; visibility is always decided
 * by the query layer (`getCommentDocument`, `getCommentTarget`). Logs carry the action, ids and
 * outcome. They never carry comment text, emails or the request body.
 */

/** Largest request body read, in characters (4,000 comment characters plus JSON escaping). */
export const MAX_REQUEST_CHARS = 64 * 1024;
/** New comments one user may post per window. */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MINUTES = 10;
/** Comments (live and placeholders) one document may hold. */
export const DOCUMENT_CAP = 1000;
/** Most comments one permanent-removal request may name. */
export const PURGE_MAX_IDS = 500;

const LOCK_NAMESPACE = "docmyrepos:doc-comments";
const USER_LOCK_NAMESPACE = "docmyrepos:comment-author";

export interface CommentDeps {
  /** The database. Default: the shared handle. */
  readonly db?: Db;
  /** Whether comments are on. Default: `comments.enabled` from the workspace settings. */
  readonly enabled?: () => boolean | Promise<boolean>;
  /** Default: the process logger. */
  readonly log?: Logger;
  /** Query options; tests swap the visibility filter. Trusted admin paths override it. */
  readonly options?: QueryOptions;
  /** Resolves the signed-in user (default `requireUser`, which throws 401). Tests only. */
  readonly user?: (db: Db) => Promise<CurrentUser>;
}

interface Ctx {
  readonly db: Db;
  readonly log: Logger;
  readonly options: QueryOptions;
  readonly user: CurrentUser;
  readonly json: unknown;
}

const ID = /^[1-9]\d{0,14}$/;

function parseId(raw: string): number | null {
  return typeof raw === "string" && ID.test(raw) ? Number(raw) : null;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

export function authFailure(error: unknown): CommentFailure {
  const status = statusOf(error);
  if (status === 401) return failure(401, "unauthorized");
  if (status === 403) return failure(403, "forbidden");
  return failure(503, "unavailable");
}

export async function isEnabled(deps: CommentDeps): Promise<boolean | CommentFailure> {
  try {
    return await (deps.enabled ?? commentsEnabled)();
  } catch {
    return failure(503, "unavailable");
  }
}

async function readJson(request: Request): Promise<{ value: unknown } | CommentFailure> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_CHARS * 4) return failure(413, "too_large");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return failure(400, "invalid_json");
  }
  if (text.length > MAX_REQUEST_CHARS) return failure(413, "too_large");
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return failure(400, "invalid_json");
  }
}

type Prepared = { ctx: Ctx } | CommentFailure;

/**
 * Steps 1 to 4. `body: false` skips the JSON parse (DELETE), `admin` requires an admin session
 * and ignores the feature flag (the moderation page must work while comments are off).
 */
async function prepare(
  request: Request,
  deps: CommentDeps,
  mode: { body: boolean; admin?: boolean },
): Promise<Prepared> {
  if (!mode.admin) {
    const enabled = await isEnabled(deps);
    if (typeof enabled === "object") return enabled;
    if (!enabled) return failure(404, "not_found");
  }
  let db: Db;
  let user: CurrentUser;
  try {
    db = deps.db ?? getDb().db;
    user = deps.user
      ? await deps.user(db)
      : mode.admin
        ? await requireAdmin(db)
        : await requireUser(db);
  } catch (error) {
    return authFailure(error);
  }
  if (mode.admin && user.role !== "admin") return failure(403, "forbidden");
  const origin = requireSameOrigin(request);
  if (!origin.ok) return failure(403, "bad_origin", { message: origin.error });
  let json: unknown = null;
  if (mode.body) {
    const parsed = await readJson(request);
    if ("ok" in parsed) return parsed;
    json = parsed.value;
  }
  return {
    ctx: {
      db,
      log: deps.log ?? logger,
      options: deps.options ?? {},
      user,
      json,
    },
  };
}

/** Maps a zod failure to a 400 naming the field. */
function invalid(error: z.ZodError): CommentFailure {
  const issue = error.issues[0];
  let field = "body";
  if (issue !== undefined) {
    const first = issue.code === "unrecognized_keys" ? issue.keys[0] : issue.path[0];
    if (typeof first === "string") field = first;
  }
  return failure(400, "invalid", { field, message: `The field "${field}" is not valid` });
}

function parseBody<T extends z.ZodType>(schema: T, json: unknown): z.infer<T> | CommentFailure {
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : invalid(parsed.error);
}

const isFailure = (value: unknown): value is CommentFailure =>
  typeof value === "object" && value !== null && "ok" in value && value.ok === false;

const RepoSlug = z
  .string()
  .max(300)
  .regex(/^[^/\s]+\/[^/\s]+$/);
const DocPath = z.string().min(1).max(4096);
const RowId = z.number().int().positive();

const CreateBody = z.strictObject({
  repo: RepoSlug,
  path: DocPath,
  body: z.string(),
  parentId: RowId.optional(),
  asOrganization: z.boolean().optional(),
});
const EditBody = z.strictObject({ body: z.string() });
const ResolveBody = z.strictObject({ resolved: z.boolean() });
const PurgeBody = z.union([
  z.strictObject({ ids: z.array(RowId).min(1).max(PURGE_MAX_IDS) }),
  z.strictObject({ githubRepoId: RowId, path: DocPath }),
]);

const REASONS = {
  empty: "The comment is empty",
  too_long: `The comment is longer than ${MAX_COMMENT_LENGTH.toLocaleString("en-US")} characters`,
} as const;

function cleanOrFail(input: string): { text: string } | CommentFailure {
  const cleaned = cleanComment(input);
  return cleaned.ok
    ? { text: cleaned.text }
    : failure(400, "invalid", { field: "body", message: REASONS[cleaned.reason] });
}

/** What a log line may carry: ids and outcomes, never text. */
interface Audit {
  readonly action: string;
  readonly userId: number;
  readonly commentId?: number;
  readonly githubRepoId?: number;
  readonly count?: number;
}

function audit(
  ctx: Pick<Ctx, "log">,
  fields: Audit,
  result: { ok: boolean; status: number; code?: string },
) {
  try {
    const out = {
      action: fields.action,
      userId: fields.userId,
      commentId: fields.commentId,
      githubRepoId: fields.githubRepoId,
      count: fields.count,
      outcome: result.ok ? "ok" : "refused",
      status: result.status,
      code: result.code,
    };
    if (result.ok) ctx.log.info(`comments.${fields.action}`, out);
    else ctx.log.warn(`comments.${fields.action}`, out);
  } catch {
    // a failing logger must not break the answer
  }
}

function logged<T extends CommentResult | PurgeResult>(
  ctx: Ctx,
  fields: Omit<Audit, "userId">,
  result: T,
): T {
  audit(ctx, { ...fields, userId: ctx.user.id }, result);
  return result;
}

async function unexpected(ctx: Pick<Ctx, "log"> | null, action: string): Promise<CommentFailure> {
  // Neither the body nor the driver's message is logged: either can carry text or a detail.
  try {
    ctx?.log.error(`comments.${action}.failed`, { action });
  } catch {
    // ignore
  }
  return failure(503, "unavailable");
}

function viewerOptions(ctx: Ctx) {
  return { ...ctx.options, includeEmail: ctx.user.role === "admin" };
}

/** The thread of `rootId` as the viewer sees it, with the comment `id` picked out of it. */
async function changeOf(
  ctx: Ctx,
  rootId: number,
  id: number,
  status: 200 | 201,
): Promise<CommentChange> {
  const thread = await getCommentThread(ctx.db, rootId, viewerOptions(ctx));
  const comment =
    thread === null
      ? null
      : thread.root.id === id
        ? thread.root
        : (thread.replies.find((r) => r.id === id) ?? null);
  return { ok: true, status, comment, thread, removed: comment === null };
}

function parseRepo(slug: string): { owner: string; name: string } {
  const [owner = "", name = ""] = slug.split("/");
  return { owner, name };
}

/** Seconds a user must wait before the oldest of their last `RATE_LIMIT` comments leaves the window. */
const windowSql = sql.raw(`interval '${RATE_WINDOW_MINUTES} minutes'`);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockDocument(tx: Tx, githubRepoId: number, path: string, userId: number) {
  // Always the author first, then the document, so two requests cannot wait on each other.
  const userKey = advisoryLockKey(USER_LOCK_NAMESPACE, String(userId));
  const docKey = advisoryLockKey(LOCK_NAMESPACE, `${githubRepoId}:${path}`);
  await tx.execute(sql`select pg_advisory_xact_lock(${userKey}::bigint)`);
  await tx.execute(sql`select pg_advisory_xact_lock(${docKey}::bigint)`);
}

/** POST: start a thread or reply. 201 with the new comment and its thread. */
export async function createComment(
  request: Request,
  deps: CommentDeps = {},
): Promise<CommentResult> {
  const prepared = await prepare(request, deps, { body: true });
  if (isFailure(prepared)) return prepared;
  const { ctx } = prepared;
  const { user } = ctx;
  try {
    const input = parseBody(CreateBody, ctx.json);
    if (isFailure(input)) return logged(ctx, { action: "create" }, input);
    const doc = await getCommentDocument(
      ctx.db,
      { repo: parseRepo(input.repo), path: input.path },
      ctx.options,
    );
    if (doc === null) return logged(ctx, { action: "create" }, failure(404, "not_found"));
    const log = { action: "create", githubRepoId: doc.githubRepoId };

    if (input.asOrganization === true && user.role !== "admin") {
      return logged(ctx, log, failure(403, "forbidden"));
    }
    let rootId: number | null = null;
    if (input.parentId !== undefined) {
      const parent = await getCommentTarget(ctx.db, input.parentId, ctx.options);
      if (
        parent === null ||
        parent.deleted ||
        parent.githubRepoId !== doc.githubRepoId ||
        parent.path !== doc.path
      ) {
        return logged(ctx, log, failure(404, "not_found"));
      }
      // One level deep: a reply to a reply joins its thread.
      rootId = parent.rootId;
    }

    const outcome = await ctx.db.transaction(async (tx) => {
      await lockDocument(tx, doc.githubRepoId, doc.path, user.id);

      const recent = await tx
        .select({
          wait: sql<number>`ceil(extract(epoch from (${docComments.createdAt} + ${windowSql} - now())))::int`,
        })
        .from(docComments)
        .where(
          and(
            eq(docComments.authorId, user.id),
            sql`${docComments.createdAt} > now() - ${windowSql}`,
          ),
        )
        .orderBy(sql`${docComments.createdAt} desc`)
        .limit(RATE_LIMIT);
      if (recent.length >= RATE_LIMIT) {
        const wait = Math.max(1, recent[RATE_LIMIT - 1]?.wait ?? 1);
        const minutes = Math.ceil(wait / 60);
        return failure(429, "rate_limited", {
          retryAfterSeconds: wait,
          message: `You are posting too fast. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        });
      }

      const [count] = await tx
        .select({
          n: sql<number>`count(*)::int`,
        })
        .from(docComments)
        .where(
          and(
            eq(docComments.githubRepoId, doc.githubRepoId),
            eq(docComments.path, doc.path),
            sql`(${docComments.deletedAt} is null or (${docComments.parentId} is null and exists (select 1 from doc_comments as replies where replies.parent_id = ${docComments.id} and replies.deleted_at is null)))`,
          ),
        );
      if ((count?.n ?? 0) >= DOCUMENT_CAP) return failure(409, "document_full");

      const cleaned = cleanOrFail(input.body);
      if (isFailure(cleaned)) return cleaned;

      if (rootId !== null) {
        const [root] = await tx
          .select({ deletedAt: docComments.deletedAt, resolvedAt: docComments.resolvedAt })
          .from(docComments)
          .where(eq(docComments.id, rootId))
          .for("update");
        if (root === undefined || root.deletedAt !== null) return failure(404, "not_found");
        if (root.resolvedAt !== null) {
          // A reply reopens its thread.
          await tx
            .update(docComments)
            .set({ resolvedAt: null, resolvedBy: null })
            .where(eq(docComments.id, rootId));
        }
      }
      const [row] = await tx
        .insert(docComments)
        .values({
          githubRepoId: doc.githubRepoId,
          path: doc.path,
          parentId: rootId,
          authorId: user.id,
          authorLabel: displayName(user.email),
          asOrg: input.asOrganization === true,
          body: cleaned.text,
        })
        .returning({ id: docComments.id });
      return { id: row?.id ?? 0 };
    });
    if (isFailure(outcome)) return logged(ctx, log, outcome);
    const result = await changeOf(ctx, rootId ?? outcome.id, outcome.id, 201);
    return logged(ctx, { ...log, commentId: outcome.id }, result);
  } catch {
    return unexpected(ctx, "create");
  }
}

/** True when `user` may change this comment's text or delete it: its author, or any admin for an organization comment. */
function mayModify(user: CurrentUser, target: CommentTarget): boolean {
  return target.asOrg ? user.role === "admin" : target.authorId === user.id;
}

type Loaded = { ctx: Ctx; id: number } | CommentFailure;

/** Steps 1 to 4 for `/api/comments/[id]` writes, with the id checked first among the inputs. */
async function prepareById(
  request: Request,
  rawId: string,
  deps: CommentDeps,
  body: boolean,
): Promise<Loaded> {
  const prepared = await prepare(request, deps, { body });
  if (isFailure(prepared)) return prepared;
  const id = parseId(rawId);
  if (id === null) return logged(prepared.ctx, { action: "id" }, failure(404, "not_found"));
  return { ctx: prepared.ctx, id };
}

async function editWith(ctx: Ctx, id: number, input: z.infer<typeof EditBody>) {
  const log = { action: "edit", commentId: id };
  const target = await getCommentTarget(ctx.db, id, ctx.options);
  if (target === null || target.deleted) return logged(ctx, log, failure(404, "not_found"));
  if (!mayModify(ctx.user, target)) return logged(ctx, log, failure(403, "forbidden"));
  const cleaned = cleanOrFail(input.body);
  if (isFailure(cleaned)) return logged(ctx, log, cleaned);
  const updated = await ctx.db
    .update(docComments)
    .set({ body: cleaned.text, editedAt: new Date() })
    .where(and(eq(docComments.id, id), isNull(docComments.deletedAt)))
    .returning({ id: docComments.id });
  if (updated.length === 0) return logged(ctx, log, failure(404, "not_found"));
  return logged(ctx, log, await changeOf(ctx, target.rootId, id, 200));
}

async function resolveWith(ctx: Ctx, id: number, input: z.infer<typeof ResolveBody>) {
  const log = { action: input.resolved ? "resolve" : "reopen", commentId: id };
  const target = await getCommentTarget(ctx.db, id, ctx.options);
  if (target === null || (target.deleted && !target.hasLiveReplies)) {
    return logged(ctx, log, failure(404, "not_found"));
  }
  if (target.parentId !== null) {
    return logged(ctx, log, failure(400, "not_a_thread", { field: "id" }));
  }
  if (target.authorId !== ctx.user.id && ctx.user.role !== "admin") {
    return logged(ctx, log, failure(403, "forbidden"));
  }
  if (target.resolved !== input.resolved) {
    await ctx.db
      .update(docComments)
      .set(
        input.resolved
          ? { resolvedAt: new Date(), resolvedBy: ctx.user.id }
          : { resolvedAt: null, resolvedBy: null },
      )
      .where(and(eq(docComments.id, id), isNull(docComments.parentId)));
  }
  return logged(ctx, log, await changeOf(ctx, id, id, 200));
}

/** PATCH `{ body }`: edit the text. Author only (admins for organization comments). */
export async function editComment(
  request: Request,
  rawId: string,
  deps: CommentDeps = {},
): Promise<CommentResult> {
  const loaded = await prepareById(request, rawId, deps, true);
  if (isFailure(loaded)) return loaded;
  try {
    const input = parseBody(EditBody, loaded.ctx.json);
    if (isFailure(input))
      return logged(loaded.ctx, { action: "edit", commentId: loaded.id }, input);
    return await editWith(loaded.ctx, loaded.id, input);
  } catch {
    return unexpected(loaded.ctx, "edit");
  }
}

/** PATCH `{ resolved }`: resolve or reopen a thread. The thread's author or any admin. */
export async function setResolved(
  request: Request,
  rawId: string,
  deps: CommentDeps = {},
): Promise<CommentResult> {
  const loaded = await prepareById(request, rawId, deps, true);
  if (isFailure(loaded)) return loaded;
  try {
    const input = parseBody(ResolveBody, loaded.ctx.json);
    if (isFailure(input)) {
      return logged(loaded.ctx, { action: "resolve", commentId: loaded.id }, input);
    }
    return await resolveWith(loaded.ctx, loaded.id, input);
  } catch {
    return unexpected(loaded.ctx, "resolve");
  }
}

/**
 * PATCH dispatcher for the route: `{ resolved }` resolves or reopens, anything else is an edit.
 * Runs steps 1 to 4 once.
 */
export async function patchComment(
  request: Request,
  rawId: string,
  deps: CommentDeps = {},
): Promise<CommentResult> {
  const loaded = await prepareById(request, rawId, deps, true);
  if (isFailure(loaded)) return loaded;
  const { ctx, id } = loaded;
  try {
    const wantsResolve =
      typeof ctx.json === "object" && ctx.json !== null && "resolved" in ctx.json;
    if (wantsResolve) {
      const input = parseBody(ResolveBody, ctx.json);
      if (isFailure(input)) return logged(ctx, { action: "resolve", commentId: id }, input);
      return await resolveWith(ctx, id, input);
    }
    const input = parseBody(EditBody, ctx.json);
    if (isFailure(input)) return logged(ctx, { action: "edit", commentId: id }, input);
    return await editWith(ctx, id, input);
  } catch {
    return unexpected(ctx, "patch");
  }
}

/** Scrubs the text and marks the comment deleted. False when it was already deleted. */
async function softDelete(db: Db, id: number, byAdmin: boolean): Promise<boolean> {
  const rows = await db
    .update(docComments)
    .set({ body: "", deletedAt: new Date(), deletedByAdmin: byAdmin })
    .where(and(eq(docComments.id, id), isNull(docComments.deletedAt)))
    .returning({ id: docComments.id });
  return rows.length > 0;
}

/**
 * DELETE: the author deletes their comment (an admin may delete an organization comment). The
 * text is removed from storage. A deleted root with replies stays as a placeholder; otherwise the
 * comment disappears (`removed: true`).
 */
export async function deleteComment(
  request: Request,
  rawId: string,
  deps: CommentDeps = {},
): Promise<CommentResult> {
  const loaded = await prepareById(request, rawId, deps, false);
  if (isFailure(loaded)) return loaded;
  const { ctx, id } = loaded;
  const log = { action: "delete", commentId: id };
  try {
    const target = await getCommentTarget(ctx.db, id, ctx.options);
    if (target === null || target.deleted) return logged(ctx, log, failure(404, "not_found"));
    if (!mayModify(ctx.user, target)) return logged(ctx, log, failure(403, "forbidden"));
    if (!(await softDelete(ctx.db, id, false))) return logged(ctx, log, failure(404, "not_found"));
    return logged(ctx, log, await changeOf(ctx, target.rootId, id, 200));
  } catch {
    return unexpected(ctx, "delete");
  }
}

/**
 * Admin DELETE (moderation): any comment, including those in blocked repositories or whose
 * document is gone, with the same effect as an author deleting it. The log line holds the admin
 * and the comment id.
 */
export async function adminDelete(
  request: Request,
  rawId: string,
  deps: CommentDeps = {},
): Promise<CommentResult> {
  const prepared = await prepare(request, deps, { body: false, admin: true });
  if (isFailure(prepared)) return prepared;
  const { ctx } = prepared;
  const id = parseId(rawId);
  const log = { action: "admin_delete", commentId: id ?? undefined };
  if (id === null) return logged(ctx, log, failure(404, "not_found"));
  try {
    const target = await getCommentTarget(ctx.db, id, {
      visibility: allowAllRepos,
      includeOrphans: true,
    });
    if (target === null || target.deleted) return logged(ctx, log, failure(404, "not_found"));
    if (!(await softDelete(ctx.db, id, true))) return logged(ctx, log, failure(404, "not_found"));
    // The thread is returned only if the admin may see it where it lives (not blocked, not orphaned).
    const result = await changeOf(ctx, target.rootId, id, 200);
    return logged(ctx, { ...log, githubRepoId: target.githubRepoId }, result);
  } catch {
    return unexpected(ctx, "admin_delete");
  }
}

/**
 * Admin POST: permanently remove comments, by `ids` or by a whole document (`githubRepoId` and
 * `path`). Only orphaned comments and deleted ones with no live reply may go; if any selected
 * comment is live (or has a live reply) on an existing document, nothing is removed and the answer
 * is 409 `not_purgeable` with the number refused. Answers the count removed.
 */
export async function adminPurge(request: Request, deps: CommentDeps = {}): Promise<PurgeResult> {
  const prepared = await prepare(request, deps, { body: true, admin: true });
  if (isFailure(prepared)) return prepared;
  const { ctx } = prepared;
  const log = { action: "admin_purge" };
  try {
    const input = parseBody(PurgeBody, ctx.json);
    if (isFailure(input)) return logged(ctx, log, input);
    const trusted = { visibility: allowAllRepos };
    const selected = await getCommentStates(
      ctx.db,
      "ids" in input ? { ids: [...new Set(input.ids)] } : input,
      trusted,
    );
    if (selected.length === 0) return logged(ctx, log, failure(404, "not_found"));
    const refused = selected.filter(
      (row) => row.state !== "orphaned" && !(row.deleted && !row.hasLiveReplies),
    );
    const githubRepoId = "githubRepoId" in input ? input.githubRepoId : undefined;
    if (refused.length > 0) {
      return logged(
        ctx,
        { ...log, githubRepoId, count: 0 },
        failure(409, "not_purgeable", { refused: refused.length }),
      );
    }
    const chosen = selected.map((row) => row.id);
    // A root takes its replies with it (they are orphaned or deleted too), so count them.
    const removed = await ctx.db
      .delete(docComments)
      .where(or(inArray(docComments.id, chosen), inArray(docComments.parentId, chosen)))
      .returning({ id: docComments.id });
    const result = { ok: true as const, status: 200 as const, removed: removed.length };
    return logged(ctx, { ...log, githubRepoId, count: removed.length }, result);
  } catch {
    return unexpected(ctx, "admin_purge");
  }
}
