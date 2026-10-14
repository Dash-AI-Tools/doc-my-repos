import { handleStatusRequest, statusMethodNotAllowed } from "@/server/status-api";

/**
 * `GET /api/status`: sync status as JSON (task 12.2), for operators, scripts and health checks.
 * Reads Postgres only, through the shared query layer; never cached; no authentication (it shows
 * what the portal pages show). All logic lives in `src/server/status-api.ts`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleStatusRequest(request);
}

export const HEAD = statusMethodNotAllowed;
export const POST = statusMethodNotAllowed;
export const PUT = statusMethodNotAllowed;
export const PATCH = statusMethodNotAllowed;
export const DELETE = statusMethodNotAllowed;
