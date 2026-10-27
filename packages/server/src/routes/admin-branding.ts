import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import { logoStoreOf } from "../branding";
import type { RouteContext } from "./index";
import { handleGetBranding, handleResetBranding, handleUpdateBranding } from "../admin/service";

/** `GET /api/admin/branding`: current settings, logo version, no bytes. */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleGetBranding(ctx.db, contextAccess(ctx));
}

/** `PUT /api/admin/branding` with a partial `{ orgName, pageTitle, ... }` body. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleUpdateBranding(request, ctx.db, contextAccess(ctx));
}

/** `DELETE /api/admin/branding`: reset everything, including the logo in the blob store. */
export async function DELETE(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleResetBranding(
    ctx.db,
    contextAccess(ctx),
    logoStoreOf(ctx.adapters.blobs, ctx.tenant),
  );
}
