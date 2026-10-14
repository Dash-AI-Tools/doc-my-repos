import { handleHealthRequest } from "@/server/health-api";
import { statusMethodNotAllowed } from "@/server/status-api";

/**
 * `GET /api/health`: the unauthenticated health check (see `src/server/health-api.ts`). Public in
 * the proxy on purpose and returns no repository data.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleHealthRequest(request);
}

export const HEAD = statusMethodNotAllowed;
export const POST = statusMethodNotAllowed;
export const PUT = statusMethodNotAllowed;
export const PATCH = statusMethodNotAllowed;
export const DELETE = statusMethodNotAllowed;
