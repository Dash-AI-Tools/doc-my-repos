import { handleMcpRequest } from "@/server/mcp/endpoint";

/**
 * The MCP endpoint for AI agents (mcp-agent-access): `POST /api/mcp`, stateless Streamable HTTP,
 * read-only, authenticated by a personal API token in `Authorization: Bearer`. It is the one API
 * route that skips the session gate in `src/proxy.ts`, because it does its own authentication.
 * Every method goes through the same handler so that the switch (404) and the method check (405
 * with `Allow: POST`) answer before anything else. Logic lives in `src/server/mcp/`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (request: Request): Promise<Response> => handleMcpRequest(request);

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const PUT = handle;
export const PATCH = handle;
export const HEAD = handle;
export const OPTIONS = handle;
