import { commentResponse, commentsMethodNotAllowed } from "@/server/comments/results";
import { adminDelete } from "@/server/comments/service";

/** `DELETE /api/admin/comments/:id`: moderator delete (needs a JSON `Content-Type`). */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return commentResponse(await adminDelete(request, (await params).id));
}

export const GET = () => commentsMethodNotAllowed("DELETE");
export const HEAD = () => commentsMethodNotAllowed("DELETE");
export const POST = () => commentsMethodNotAllowed("DELETE");
export const PUT = () => commentsMethodNotAllowed("DELETE");
export const PATCH = () => commentsMethodNotAllowed("DELETE");
