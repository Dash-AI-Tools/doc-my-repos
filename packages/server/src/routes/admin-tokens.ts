import { contextAccess } from "../auth/access";
import { mcpEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleListAllTokens, tokenMethodNotAllowed } from "../mcp/token-api";

/** `GET /api/admin/tokens` lists every user's AI agent tokens. Admin session only. */

const ALLOW = "GET";

export async function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleListAllTokens(request, {
    db: ctx.db,
    enabled: () => mcpEnabled(ctx),
    access: contextAccess(ctx),
  });
}

export const HEAD = () => tokenMethodNotAllowed(ALLOW);
export const POST = () => tokenMethodNotAllowed(ALLOW);
export const PUT = () => tokenMethodNotAllowed(ALLOW);
export const PATCH = () => tokenMethodNotAllowed(ALLOW);
export const DELETE = () => tokenMethodNotAllowed(ALLOW);
