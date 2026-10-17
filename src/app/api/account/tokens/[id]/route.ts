import { handleRevokeOwnToken, tokenMethodNotAllowed } from "@/server/mcp/token-api";

/** `DELETE /api/account/tokens/:id` revokes one of the signed-in user's tokens. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW = "DELETE";

export function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return params.then((p) => handleRevokeOwnToken(request, p.id));
}

export const GET = () => tokenMethodNotAllowed(ALLOW);
export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const POST = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
