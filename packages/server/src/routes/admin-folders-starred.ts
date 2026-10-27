import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleReorderFolders } from "../admin/service";

/** `PUT /api/admin/folders/starred` with `{folderIds: number[]}`: the new starred order. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleReorderFolders(request, ctx.db, contextAccess(ctx));
}
