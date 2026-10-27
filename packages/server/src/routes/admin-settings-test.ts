import { tenantDeps } from "../app/context";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleTestGithub } from "../admin/settings";

/** `POST /api/admin/settings/test`: tries the GitHub App settings; never saves anything. */
export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleTestGithub(request, tenantDeps(ctx));
}
