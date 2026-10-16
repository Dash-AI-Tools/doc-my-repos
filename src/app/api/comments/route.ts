import { handleListComments } from "@/server/comments/read-api";
import { commentResponse, commentsMethodNotAllowed } from "@/server/comments/results";
import { createComment } from "@/server/comments/service";

/**
 * `GET /api/comments?repo=owner/name&path=...[&cursor=...]` lists a document's threads;
 * `POST /api/comments` adds a comment. Logic lives in `src/server/comments/`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW = "GET, POST";

export function GET(request: Request): Promise<Response> {
  return handleListComments(request);
}

export async function POST(request: Request): Promise<Response> {
  return commentResponse(await createComment(request));
}

export const HEAD = () => commentsMethodNotAllowed(ALLOW);
export const PUT = () => commentsMethodNotAllowed(ALLOW);
export const PATCH = () => commentsMethodNotAllowed(ALLOW);
export const DELETE = () => commentsMethodNotAllowed(ALLOW);
