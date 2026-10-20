import { handleDeleteFolder, handleUpdateFolder } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `PATCH /api/admin/folders/:id` with any of `{name, description, isStarred}`. */
export function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return params.then((p) => handleUpdateFolder(Number(p.id), request));
}

/** `DELETE /api/admin/folders/:id`: its repositories become folderless. */
export function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return params.then((p) => handleDeleteFolder(Number(p.id)));
}
