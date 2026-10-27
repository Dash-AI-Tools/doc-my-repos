import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import { handleSearchRequest, methodNotAllowed } from "../search-api";
import type { RouteContext } from "./index";

/**
 * `GET /api/search?q=<text>&limit=<1-10>&repo=<owner/name>`: live results for the command palette
 * (task 10.4). Reads Postgres only, through the shared query layer; never cached. All logic lives
 * in `packages/server/src/search-api.ts`. Put a per-client rate limit on this path in the reverse proxy: the
 * app only caps how many searches run at once.
 */

export function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleSearchRequest(request, { db: ctx.db, emit: contextAccess(ctx).emit });
}

// Every other method is refused with `Allow: GET`, without reading the request.
export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
