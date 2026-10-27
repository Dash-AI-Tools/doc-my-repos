import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleCreateUser, handleListUsers } from "../admin/service";

/** `GET /api/admin/users`: admin-only user list (no password hashes). */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleListUsers(ctx.db, contextAccess(ctx));
}

/** `POST /api/admin/users` with `{email, password, role}`. 409 on duplicate email. */
export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleCreateUser(request, ctx.db, contextAccess(ctx));
}
