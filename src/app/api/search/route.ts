import { handleSearchRequest, methodNotAllowed } from "@/server/search-api";

/**
 * `GET /api/search?q=<text>&limit=<1-10>&repo=<owner/name>`: live results for the command palette
 * (task 10.4). Reads Postgres only, through the shared query layer; never cached. All logic lives
 * in `src/server/search-api.ts`. Put a per-client rate limit on this path in the reverse proxy: the
 * app only caps how many searches run at once.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleSearchRequest(request);
}

// Every other method is refused with `Allow: GET`, without reading the request.
export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
