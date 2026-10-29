import { contextAccess } from "../auth/access";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleAsk } from "../ask/handler";
import { readerOf } from "../public-access/reader";
import { filterFor } from "../queries/visibility";

/**
 * `POST /api/ask`: asks a question about the documentation and streams the answer as server-sent
 * events. Logic lives in `packages/server/src/ask/handler.ts`.
 */

export async function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  // A visitor without a session (when anonymous Ask is on) is answered from public repositories
  // only, against the shared anonymous caps.
  const reader = await readerOf(ctx);
  return handleAsk(request, {
    reader,
    options: { visibility: filterFor(reader) },
    db: ctx.db,
    tenantId: ctx.tenant.id,
    access: contextAccess(ctx),
    workspace: () => ctx.workspace(),
    entitled: () => ctx.entitled("ask"),
  });
}

const notAllowed = () =>
  new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export const GET = notAllowed;
export const HEAD = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
