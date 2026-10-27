import { contextAccess } from "../auth/access";
import { commentsEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleAdminListComments } from "../comments/read-api";
import { commentsMethodNotAllowed } from "../comments/results";

/** `GET /api/admin/comments?state=&githubRepoId=&cursor=&limit=`: the moderation list. */

export async function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleAdminListComments(request, {
    db: ctx.db,
    enabled: () => commentsEnabled(ctx),
    access: contextAccess(ctx),
  });
}

export const HEAD = () => commentsMethodNotAllowed("GET");
export const POST = () => commentsMethodNotAllowed("GET");
export const PUT = () => commentsMethodNotAllowed("GET");
export const PATCH = () => commentsMethodNotAllowed("GET");
export const DELETE = () => commentsMethodNotAllowed("GET");
