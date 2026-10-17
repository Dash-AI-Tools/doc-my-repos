import { handleListAllTokens, tokenMethodNotAllowed } from "@/server/mcp/token-api";

/** `GET /api/admin/tokens` lists every user's AI agent tokens. Admin session only. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW = "GET";

export function GET(request: Request): Promise<Response> {
  return handleListAllTokens(request);
}

export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const POST = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
export const DELETE = () => tokenMethodNotAllowed(ALLOW);
