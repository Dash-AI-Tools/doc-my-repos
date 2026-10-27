import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import { handleDeleteFolder, handleUpdateFolder } from "../admin/service";

/** `PATCH /api/admin/folders/:id` with any of `{name, description, isStarred}`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: RequestContext,
): Promise<Response> {
  return params.then((p) => handleUpdateFolder(Number(p.id), request, ctx.db, contextAccess(ctx)));
}

/** `DELETE /api/admin/folders/:id`: its repositories become folderless. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: RequestContext,
): Promise<Response> {
  return params.then((p) => handleDeleteFolder(Number(p.id), ctx.db, contextAccess(ctx)));
}
