import { tenantDeps } from "../app/context";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleGetPublicAccess, handleSavePublicAccess } from "../admin/public-access";

/** `GET /api/admin/public-access`: the settings and whether anything is public. */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleGetPublicAccess(tenantDeps(ctx));
}

/** `PUT /api/admin/public-access` with any of the four settings. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleSavePublicAccess(request, tenantDeps(ctx));
}
