import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleReorderStarred } from "../admin/service";

/** `PUT /api/admin/repos/starred` with `{repos: [{owner, name}, ...]}`: the new starred order. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleReorderStarred(request, ctx.db, contextAccess(ctx));
}
