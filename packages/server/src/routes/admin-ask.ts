import { tenantDeps } from "../app/context";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleGetAsk, handleSaveAsk } from "../admin/ask";

/** `GET /api/admin/ask`: the saved choice, each provider's availability, and the current state. */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleGetAsk(tenantDeps(ctx));
}

/** `PUT /api/admin/ask` with `{ enabled, provider?, model? }`. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleSaveAsk(request, tenantDeps(ctx));
}
