import { tenantDeps } from "../app/context";
import type { RequestContext } from "../app/types";
import type { RouteContext } from "./index";
import { handleGetSettings, handleSaveSettings } from "../admin/settings";

/** `GET /api/admin/settings`: the workspace settings, whether each secret is set, and what is missing. */
export async function GET(
  _request: Request | undefined,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleGetSettings(tenantDeps(ctx));
}

/** `PUT /api/admin/settings` with `{ expectedVersion, settings?, secrets? }`. Secrets are write-only. */
export async function PUT(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleSaveSettings(request, tenantDeps(ctx));
}
