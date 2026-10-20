import { handleCreateFolder, handleListFolders } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/folders`: every folder, starred first in order. */
export function GET(): Promise<Response> {
  return handleListFolders();
}

/** `POST /api/admin/folders` with `{name, description?}`. */
export function POST(request: Request): Promise<Response> {
  return handleCreateFolder(request);
}
