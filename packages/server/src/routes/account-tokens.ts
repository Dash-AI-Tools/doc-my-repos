import { contextAccess } from "../auth/access";
import { mcpEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleCreateToken, handleListOwnTokens, tokenMethodNotAllowed } from "../mcp/token-api";

/**
 * `GET /api/account/tokens` lists the signed-in user's AI agent tokens; `POST` creates one and
 * returns the full token once. Session routes: a bearer token alone is refused. Logic lives in
 * `packages/server/src/mcp/token-api.ts`.
 */

const ALLOW = "GET, POST";

export async function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleListOwnTokens(request, {
    db: ctx.db,
    enabled: () => mcpEnabled(ctx),
    access: contextAccess(ctx),
  });
}

export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleCreateToken(request, {
    db: ctx.db,
    enabled: () => mcpEnabled(ctx),
    access: contextAccess(ctx),
  });
}

export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
export const DELETE = () => tokenMethodNotAllowed(ALLOW);
