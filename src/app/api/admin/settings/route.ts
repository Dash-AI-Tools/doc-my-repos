import { handleGetSettings, handleSaveSettings } from "@/server/admin/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/settings`: the workspace settings, whether each secret is set, and what is missing. */
export function GET(): Promise<Response> {
  return handleGetSettings();
}

/** `PUT /api/admin/settings` with `{ expectedVersion, settings?, secrets? }`. Secrets are write-only. */
export function PUT(request: Request): Promise<Response> {
  return handleSaveSettings(request);
}
