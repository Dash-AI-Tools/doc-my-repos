import { handleAdminSync } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/admin/sync`: syncs every repository now; admin session instead of `SYNC_SECRET`. */
export function POST(request: Request): Promise<Response> {
  return handleAdminSync(request);
}
