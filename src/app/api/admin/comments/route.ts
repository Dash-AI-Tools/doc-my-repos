import { handleAdminListComments } from "@/server/comments/read-api";
import { commentsMethodNotAllowed } from "@/server/comments/results";

/** `GET /api/admin/comments?state=&githubRepoId=&cursor=&limit=`: the moderation list. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleAdminListComments(request);
}

export const HEAD = () => commentsMethodNotAllowed("GET");
export const POST = () => commentsMethodNotAllowed("GET");
export const PUT = () => commentsMethodNotAllowed("GET");
export const PATCH = () => commentsMethodNotAllowed("GET");
export const DELETE = () => commentsMethodNotAllowed("GET");
