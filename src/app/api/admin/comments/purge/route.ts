import { commentResponse, commentsMethodNotAllowed } from "@/server/comments/results";
import { adminPurge } from "@/server/comments/service";

/** `POST /api/admin/comments/purge` with `{ ids }` or `{ githubRepoId, path }`. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return commentResponse(await adminPurge(request));
}

export const GET = () => commentsMethodNotAllowed("POST");
export const HEAD = () => commentsMethodNotAllowed("POST");
export const PUT = () => commentsMethodNotAllowed("POST");
export const PATCH = () => commentsMethodNotAllowed("POST");
export const DELETE = () => commentsMethodNotAllowed("POST");
