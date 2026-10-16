import { commentResponse, commentsMethodNotAllowed } from "@/server/comments/results";
import { deleteComment, patchComment } from "@/server/comments/service";

/**
 * `PATCH /api/comments/:id` with `{ body }` (edit) or `{ resolved }` (resolve or reopen);
 * `DELETE /api/comments/:id`. Both need a JSON `Content-Type`, DELETE included.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW = "PATCH, DELETE";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  return commentResponse(await patchComment(request, (await params).id));
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  return commentResponse(await deleteComment(request, (await params).id));
}

export const GET = () => commentsMethodNotAllowed(ALLOW);
export const HEAD = () => commentsMethodNotAllowed(ALLOW);
export const POST = () => commentsMethodNotAllowed(ALLOW);
export const PUT = () => commentsMethodNotAllowed(ALLOW);
