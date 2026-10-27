import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import { logoStoreOf } from "../branding";
import type { RouteContext } from "./index";
import { handleRemoveLogo, handleUploadLogo } from "../admin/service";

/** `PUT /api/admin/branding/logo`: raw image body, type sniffed from bytes, to the blob store. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleUploadLogo(
    request,
    ctx.db,
    contextAccess(ctx),
    logoStoreOf(ctx.adapters.blobs, ctx.tenant),
  );
}

/** `DELETE /api/admin/branding/logo`: remove the logo. */
export async function DELETE(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleRemoveLogo(ctx.db, contextAccess(ctx), logoStoreOf(ctx.adapters.blobs, ctx.tenant));
}
