import {
  handleCreateToken,
  handleListOwnTokens,
  tokenMethodNotAllowed,
} from "@/server/mcp/token-api";

/**
 * `GET /api/account/tokens` lists the signed-in user's AI agent tokens; `POST` creates one and
 * returns the full token once. Session routes: a bearer token alone is refused. Logic lives in
 * `src/server/mcp/token-api.ts`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW = "GET, POST";

export function GET(request: Request): Promise<Response> {
  return handleListOwnTokens(request);
}

export function POST(request: Request): Promise<Response> {
  return handleCreateToken(request);
}

export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
export const DELETE = () => tokenMethodNotAllowed(ALLOW);
