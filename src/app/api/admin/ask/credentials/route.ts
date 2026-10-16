import { handleSaveProviderCredentials } from "@/server/admin/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `PUT /api/admin/ask/credentials` with `{ expectedVersion, openaiBaseUrl?, secrets? }`. */
export function PUT(request: Request): Promise<Response> {
  return handleSaveProviderCredentials(request);
}
