import { handleManualSync, methodNotAllowed } from "@/server/sync/manual-sync";
import { getSyncService, readConfiguredSyncSecret } from "@/server/sync/service";

/**
 * `POST /api/sync`: manual sync of all repositories or one, guarded by `SYNC_SECRET`.
 *
 *   curl -X POST -H "Authorization: Bearer $SYNC_SECRET" https://host/api/sync
 *   curl -X POST -H "Authorization: Bearer $SYNC_SECRET" -d '{"repo":"handbook"}' https://host/api/sync
 *
 * The body is optional: `{"repo":"name"}`, `{"repo":"owner/name"}` or `{"githubId":123}`. All logic
 * lives in `src/server/sync/manual-sync.ts`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleManualSync(request, {
    readSecret: () => readConfiguredSyncSecret(),
    getService: getSyncService,
  });
}

// Every other method is refused with `Allow: POST`, without reading the request.
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
