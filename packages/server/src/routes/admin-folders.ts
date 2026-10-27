import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleCreateFolder, handleListFolders } from "../admin/service";

/** `GET /api/admin/folders`: every folder, starred first in order. */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleListFolders(ctx.db, contextAccess(ctx));
}

/** `POST /api/admin/folders` with `{name, description?}`. */
export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleCreateFolder(request, ctx.db, contextAccess(ctx));
}
