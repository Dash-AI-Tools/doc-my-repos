import type { RequestContext } from "../app/types";
import { logoStoreOf } from "../branding";
import { handleLogoRequest } from "../branding/serve";
import type { RouteContext } from "./index";

/** `GET /api/branding/logo`: the portal logo, public (the sign-in page shows it). */
export function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleLogoRequest(request, ctx.db, logoStoreOf(ctx.adapters.blobs, ctx.tenant));
}

/** Same headers without the body. */
export const HEAD = GET;
