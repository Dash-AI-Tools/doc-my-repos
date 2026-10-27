import { handleHealthRequest } from "../health-api";
import { statusMethodNotAllowed } from "../status-api";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";

/**
 * `GET /api/health`: the unauthenticated health check (see `packages/server/src/health-api.ts`). Public in
 * the proxy on purpose and returns no repository data.
 */

export function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleHealthRequest(request, { db: ctx.db });
}

export const HEAD = statusMethodNotAllowed;
export const POST = statusMethodNotAllowed;
export const PUT = statusMethodNotAllowed;
export const PATCH = statusMethodNotAllowed;
export const DELETE = statusMethodNotAllowed;
