import { handleReorderFolders } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `PUT /api/admin/folders/starred` with `{folderIds: number[]}`: the new starred order. */
export function PUT(request: Request): Promise<Response> {
  return handleReorderFolders(request);
}
