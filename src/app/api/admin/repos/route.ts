import { handleListRepos, handleSetRepoAllowed } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/repos`: full repo list for admins, blocked included. */
export function GET(): Promise<Response> {
  return handleListRepos();
}

/** `PATCH /api/admin/repos` with `{owner, name, isAllowed}`. */
export function PATCH(request: Request): Promise<Response> {
  return handleSetRepoAllowed(request);
}
