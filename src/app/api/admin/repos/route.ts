import { handleListRepos, handleUpdateRepo } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/repos`: full repo list for admins, blocked included. */
export function GET(): Promise<Response> {
  return handleListRepos();
}

/** `PATCH /api/admin/repos` with `{owner, name}` and `isAllowed` and/or `isStarred`. */
export function PATCH(request: Request): Promise<Response> {
  return handleUpdateRepo(request);
}
