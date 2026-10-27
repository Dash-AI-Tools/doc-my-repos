import { mcpEnabled } from "../workspace";
import type { RequestContext } from "../app/types";
import { handleMcpRequest } from "../mcp/endpoint";
import type { RouteContext } from "./index";

/**
 * The MCP endpoint for AI agents (mcp-agent-access): `POST /api/mcp`, stateless Streamable HTTP,
 * read-only, authenticated by a personal API token in `Authorization: Bearer`. It is the one API
 * route that skips the session gate in the proxy, because it does its own authentication.
 * Every method goes through the same handler so that the switch (404) and the method check (405
 * with `Allow: POST`) answer before anything else. Logic lives in `packages/server/src/mcp/`.
 */
const handle = (
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> =>
  handleMcpRequest(request, {
    db: ctx.db,
    tenantId: ctx.tenant.id,
    enabled: () => mcpEnabled(ctx),
    emit: ctx.emit,
  });

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const PUT = handle;
export const PATCH = handle;
export const HEAD = handle;
export const OPTIONS = handle;
