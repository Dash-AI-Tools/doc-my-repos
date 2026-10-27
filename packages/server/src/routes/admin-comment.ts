import { contextAccess } from "../auth/access";
import { commentsEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import { commentResponse, commentsMethodNotAllowed } from "../comments/results";
import { adminDelete } from "../comments/service";

/** `DELETE /api/admin/comments/:id`: moderator delete (needs a JSON `Content-Type`). */

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: RequestContext,
): Promise<Response> {
  return commentResponse(
    await adminDelete(request, (await params).id, {
      db: ctx.db,
      enabled: () => commentsEnabled(ctx),
      access: contextAccess(ctx),
    }),
  );
}

export const GET = () => commentsMethodNotAllowed("DELETE");
export const HEAD = () => commentsMethodNotAllowed("DELETE");
export const POST = () => commentsMethodNotAllowed("DELETE");
export const PUT = () => commentsMethodNotAllowed("DELETE");
export const PATCH = () => commentsMethodNotAllowed("DELETE");
