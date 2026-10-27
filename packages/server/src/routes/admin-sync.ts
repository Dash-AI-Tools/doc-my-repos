import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleAdminSync } from "../admin/service";
import { contextSyncService } from "../sync/service";

/**
 * `POST /api/admin/sync`: syncs every repository now, over the request's tenant's workspace;
 * admin session instead of `SYNC_SECRET`.
 */
export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleAdminSync(request, ctx.db, contextAccess(ctx), () => contextSyncService(ctx));
}
