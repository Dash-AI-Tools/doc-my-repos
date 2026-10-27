import { contextAccess } from "../auth/access";
import { commentsEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleListComments } from "../comments/read-api";
import { commentResponse, commentsMethodNotAllowed } from "../comments/results";
import { createComment } from "../comments/service";

/**
 * `GET /api/comments?repo=owner/name&path=...[&cursor=...]` lists a document's threads;
 * `POST /api/comments` adds a comment. Logic lives in `packages/server/src/comments/`.
 */

const ALLOW = "GET, POST";

export async function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleListComments(request, {
    db: ctx.db,
    enabled: () => commentsEnabled(ctx),
    access: contextAccess(ctx),
  });
}

export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return commentResponse(
    await createComment(request, {
      db: ctx.db,
      enabled: () => commentsEnabled(ctx),
      access: contextAccess(ctx),
    }),
  );
}

export const HEAD = () => commentsMethodNotAllowed(ALLOW);
export const PUT = () => commentsMethodNotAllowed(ALLOW);
export const PATCH = () => commentsMethodNotAllowed(ALLOW);
export const DELETE = () => commentsMethodNotAllowed(ALLOW);
