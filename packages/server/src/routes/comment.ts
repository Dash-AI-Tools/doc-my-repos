import { contextAccess } from "../auth/access";
import { commentsEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import { commentResponse, commentsMethodNotAllowed } from "../comments/results";
import { deleteComment, patchComment } from "../comments/service";

/**
 * `PATCH /api/comments/:id` with `{ body }` (edit) or `{ resolved }` (resolve or reopen);
 * `DELETE /api/comments/:id`. Both need a JSON `Content-Type`, DELETE included.
 */

const ALLOW = "PATCH, DELETE";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(
  request: Request,
  { params }: Context,
  ctx: RequestContext,
): Promise<Response> {
  return commentResponse(
    await patchComment(request, (await params).id, {
      db: ctx.db,
      enabled: () => commentsEnabled(ctx),
      access: contextAccess(ctx),
    }),
  );
}

export async function DELETE(
  request: Request,
  { params }: Context,
  ctx: RequestContext,
): Promise<Response> {
  return commentResponse(
    await deleteComment(request, (await params).id, {
      db: ctx.db,
      enabled: () => commentsEnabled(ctx),
      access: contextAccess(ctx),
    }),
  );
}

export const GET = () => commentsMethodNotAllowed(ALLOW);
export const HEAD = () => commentsMethodNotAllowed(ALLOW);
export const POST = () => commentsMethodNotAllowed(ALLOW);
export const PUT = () => commentsMethodNotAllowed(ALLOW);
