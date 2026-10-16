import { handleReorderStarred } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `PUT /api/admin/repos/starred` with `{repos: [{owner, name}, ...]}`: the new starred order. */
export function PUT(request: Request): Promise<Response> {
  return handleReorderStarred(request);
}
