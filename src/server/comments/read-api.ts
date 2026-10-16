import "server-only";

import { authErrorResponse, requireAdmin, requireUser } from "../auth/current-user";
import { getDb, type Db } from "../db/client";
import { logger } from "../log";
import {
  getCommentDocument,
  isCommentCursor,
  listCommentsForModeration,
  listDocComments,
  type CommentState,
} from "../queries";
import { allowAllRepos } from "../queries/visibility";
import { authFailure, isEnabled, type CommentDeps } from "./service";
import { commentJson, commentResponse, failure, type CommentFailure } from "./results";

/**
 * Comment read handlers (document-comments task 3.1 and 3.2): `GET /api/comments` for the
 * document page's "Show more" and `GET /api/admin/comments` for moderation. Order of checks for
 * the reader: feature flag (404), session (401), query parameters (400), document visible through
 * the query layer (404), then the read. The admin read needs an admin session and works while
 * comments are off. Responses are `no-store`; errors are fixed bodies.
 */

const REPO = /^([^/\s]{1,100})\/([^/\s]{1,100})$/;
const STATES: readonly CommentState[] = ["live", "deleted", "orphaned", "blocked"];

function bad(field: string): CommentFailure {
  return failure(400, "invalid", { field, message: `The field "${field}" is not valid` });
}

function paramsOf(request: Request): URLSearchParams | null {
  try {
    return new URL(request.url).searchParams;
  } catch {
    return null;
  }
}

/** The single value of `name`, `undefined` when absent, or `null` when it is repeated. */
function single(params: URLSearchParams, name: string): string | undefined | null {
  const all = params.getAll(name);
  if (all.length > 1) return null;
  return all[0];
}

export interface DocCommentsQuery {
  readonly repo: { readonly owner: string; readonly name: string };
  readonly path: string;
  readonly cursor: string | null;
}

/** Parses `repo=owner/name`, `path` and the optional `cursor`. */
export function parseDocCommentsQuery(params: URLSearchParams): DocCommentsQuery | CommentFailure {
  const repo = single(params, "repo");
  const match = typeof repo === "string" ? REPO.exec(repo) : null;
  if (match === null) return bad("repo");
  const path = single(params, "path");
  if (typeof path !== "string" || path === "" || path.length > 4096) return bad("path");
  const cursor = single(params, "cursor");
  if (cursor === null || (cursor !== undefined && cursor !== "" && !isCommentCursor(cursor))) {
    return bad("cursor");
  }
  return { repo: { owner: match[1]!, name: match[2]! }, path, cursor: cursor || null };
}

/**
 * `GET /api/comments?repo=owner/name&path=docs/a.md[&cursor=...]`.
 * 200 `{ threads, nextCursor }`; emails appear only for admins.
 */
export async function handleListComments(
  request: Request,
  deps: CommentDeps = {},
): Promise<Response> {
  const enabled = isEnabled(deps);
  if (typeof enabled === "object") return commentResponse(enabled);
  if (!enabled) return commentResponse(failure(404, "not_found"));
  try {
    const db: Db = deps.db ?? getDb().db;
    let user;
    try {
      user = deps.user ? await deps.user(db) : await requireUser(db);
    } catch (error) {
      return commentResponse(authFailure(error));
    }
    const params = paramsOf(request);
    const query = params === null ? bad("repo") : parseDocCommentsQuery(params);
    if ("ok" in query) return commentResponse(query);
    const options = deps.options ?? {};
    const doc = await getCommentDocument(db, { repo: query.repo, path: query.path }, options);
    if (doc === null) return commentResponse(failure(404, "not_found"));
    const page = await listDocComments(
      db,
      {
        repo: query.repo,
        path: doc.path,
        cursor: query.cursor,
        includeEmail: user.role === "admin",
      },
      options,
    );
    return commentJson(200, page);
  } catch {
    try {
      (deps.log ?? logger).error("comments.list.failed", { action: "list" });
    } catch {
      // ignore
    }
    return commentResponse(failure(503, "unavailable"));
  }
}

/**
 * `GET /api/admin/comments?state=&githubRepoId=&cursor=&limit=`: every comment, newest first, for
 * the moderation page. 200 `{ items, nextCursor }`. Admin only; independent of `comments.enabled`.
 */
export async function handleAdminListComments(
  request: Request,
  deps: CommentDeps = {},
): Promise<Response> {
  let db: Db;
  try {
    db = deps.db ?? getDb().db;
    if (deps.user) {
      const user = await deps.user(db);
      if (user.role !== "admin") return authErrorResponse({ status: 403 });
    } else {
      await requireAdmin(db);
    }
  } catch (error) {
    return authErrorResponse(error);
  }
  const params = paramsOf(request);
  if (params === null) return commentResponse(bad("state"));
  const state = single(params, "state");
  if (state === null || (state !== undefined && state !== "" && !STATES.includes(state as never))) {
    return commentResponse(bad("state"));
  }
  const repoId = single(params, "githubRepoId");
  if (
    repoId === null ||
    (repoId !== undefined && repoId !== "" && !/^[1-9]\d{0,14}$/.test(repoId))
  ) {
    return commentResponse(bad("githubRepoId"));
  }
  const cursor = single(params, "cursor");
  if (cursor === null || (cursor !== undefined && cursor !== "" && !isCommentCursor(cursor))) {
    return commentResponse(bad("cursor"));
  }
  const limit = single(params, "limit");
  if (limit === null || (limit !== undefined && limit !== "" && !/^\d{1,3}$/.test(limit))) {
    return commentResponse(bad("limit"));
  }
  try {
    const page = await listCommentsForModeration(
      db,
      {
        state: state ? (state as CommentState) : undefined,
        githubRepoId: repoId ? Number(repoId) : undefined,
        cursor: cursor || null,
        limit: limit ? Math.max(1, Number(limit)) : undefined,
      },
      { visibility: allowAllRepos },
    );
    return commentJson(200, page);
  } catch {
    try {
      (deps.log ?? logger).error("comments.admin_list.failed", { action: "admin_list" });
    } catch {
      // ignore
    }
    return commentResponse(failure(503, "unavailable"));
  }
}
