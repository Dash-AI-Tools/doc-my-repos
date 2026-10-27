import { contextAccess } from "../auth/access";
import { commentsEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { commentResponse, commentsMethodNotAllowed } from "../comments/results";
import { adminPurge } from "../comments/service";

/** `POST /api/admin/comments/purge` with `{ ids }` or `{ githubRepoId, path }`. */

export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return commentResponse(
    await adminPurge(request, {
      db: ctx.db,
      enabled: () => commentsEnabled(ctx),
      access: contextAccess(ctx),
    }),
  );
}

export const GET = () => commentsMethodNotAllowed("POST");
export const HEAD = () => commentsMethodNotAllowed("POST");
export const PUT = () => commentsMethodNotAllowed("POST");
export const PATCH = () => commentsMethodNotAllowed("POST");
export const DELETE = () => commentsMethodNotAllowed("POST");
