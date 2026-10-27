import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleListRepos, handleUpdateRepo } from "../admin/service";

/** `GET /api/admin/repos`: full repo list for admins, blocked included. */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleListRepos(ctx.db, contextAccess(ctx));
}

/** `PATCH /api/admin/repos` with `{owner, name}` and `isAllowed` and/or `isStarred`. */
export async function PATCH(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleUpdateRepo(request, ctx.db, contextAccess(ctx));
}
