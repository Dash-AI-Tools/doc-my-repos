import { contextAccess } from "../auth/access";
import { mcpEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import { handleRevokeAnyToken, tokenMethodNotAllowed } from "../mcp/token-api";

/** `DELETE /api/admin/tokens/:id` revokes any user's AI agent token. Admin session only. */

const ALLOW = "DELETE";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: RequestContext,
): Promise<Response> {
  return params.then((p) =>
    handleRevokeAnyToken(request, p.id, {
      db: ctx.db,
      enabled: () => mcpEnabled(ctx),
      access: contextAccess(ctx),
    }),
  );
}

export const GET = () => tokenMethodNotAllowed(ALLOW);
export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const POST = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
