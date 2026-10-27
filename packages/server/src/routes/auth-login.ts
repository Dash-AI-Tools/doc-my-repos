import type { RequestContext } from "../app/types";
import type { RouteContext, RouteEnv } from "./index";
import { handleLogin } from "../auth/service";

/**
 * `POST /api/auth/login` with `{"email","password"}`. Generic 401 on failure, signed session
 * cookie on success. All logic lives in `packages/server/src/auth/service.ts`.
 */
export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
  env: RouteEnv,
): Promise<Response> {
  return handleLogin(request, {
    db: ctx.db,
    tenantId: ctx.tenant.id,
    emit: ctx.emit,
    source: env.config.source,
  });
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
