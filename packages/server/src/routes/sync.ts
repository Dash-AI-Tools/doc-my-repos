import type { RequestContext } from "../app/types";
import { readSyncSecret } from "../config/env";
import { handleManualSync, methodNotAllowed } from "../sync/manual-sync";
import { contextSyncService } from "../sync/service";
import type { RouteContext, RouteEnv } from "./index";

/**
 * `POST /api/sync`: manual sync of all repositories or one, guarded by `SYNC_SECRET`.
 *
 *   curl -X POST -H "Authorization: Bearer $SYNC_SECRET" https://host/api/sync
 *   curl -X POST -H "Authorization: Bearer $SYNC_SECRET" -d '{"repo":"handbook"}' https://host/api/sync
 *
 * The body is optional: `{"repo":"name"}`, `{"repo":"owner/name"}` or `{"githubId":123}`. The
 * secret comes from the app's startup configuration and the sync runs over the request's tenant's
 * workspace, re-checked so a saved change applies. All logic lives in
 * `packages/server/src/sync/manual-sync.ts`.
 */
export function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
  env: RouteEnv,
): Promise<Response> {
  return handleManualSync(request, {
    readSecret: () => readSyncSecret(env.config.source)?.reveal() ?? null,
    getService: () => contextSyncService(ctx),
  });
}

// Every other method is refused with `Allow: POST`, without reading the request.
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
