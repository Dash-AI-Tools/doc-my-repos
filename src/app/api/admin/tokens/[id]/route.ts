import { handleRevokeAnyToken, tokenMethodNotAllowed } from "@/server/mcp/token-api";

/** `DELETE /api/admin/tokens/:id` revokes any user's AI agent token. Admin session only. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW = "DELETE";

export function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return params.then((p) => handleRevokeAnyToken(request, p.id));
}

export const GET = () => tokenMethodNotAllowed(ALLOW);
export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const POST = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
