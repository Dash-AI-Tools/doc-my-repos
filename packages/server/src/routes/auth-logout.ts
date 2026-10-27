import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleLogout } from "../auth/service";

/** `POST /api/auth/logout`: clears the session cookie. */
export function POST(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleLogout({ user: () => ctx.user(), emit: ctx.emit });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}
