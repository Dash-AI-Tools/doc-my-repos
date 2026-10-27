import type { RequestContext } from "../app/types";
import { handleStatusRequest, statusMethodNotAllowed } from "../status-api";
import type { RouteContext } from "./index";

/**
 * `GET /api/status`: sync status as JSON (task 12.2), for operators, scripts and health checks.
 * Reads Postgres only, through the shared query layer; never cached; no authentication (it shows
 * what the portal pages show). All logic lives in `packages/server/src/status-api.ts`.
 */

export function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleStatusRequest(request, { db: ctx.db });
}

export const HEAD = statusMethodNotAllowed;
export const POST = statusMethodNotAllowed;
export const PUT = statusMethodNotAllowed;
export const PATCH = statusMethodNotAllowed;
export const DELETE = statusMethodNotAllowed;
