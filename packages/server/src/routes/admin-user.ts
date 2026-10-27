import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import { handleUpdateUser } from "../admin/service";

/** `PATCH /api/admin/users/:id` with any of `{role, disabled, password}`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: RequestContext,
): Promise<Response> {
  return params.then((p) => handleUpdateUser(Number(p.id), request, ctx.db, contextAccess(ctx)));
}
