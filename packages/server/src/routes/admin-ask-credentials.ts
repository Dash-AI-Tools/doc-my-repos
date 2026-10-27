import { tenantDeps } from "../app/context";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleSaveProviderCredentials } from "../admin/settings";

/** `PUT /api/admin/ask/credentials` with `{ expectedVersion, openaiBaseUrl?, secrets? }`. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleSaveProviderCredentials(request, tenantDeps(ctx));
}
