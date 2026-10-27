import { tenantDeps } from "../app/context";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleTestAsk } from "../admin/ask";

/** `POST /api/admin/ask/test` with `{ provider, model }`: one fixed request, one fixed result word. */
export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleTestAsk(request, tenantDeps(ctx));
}
