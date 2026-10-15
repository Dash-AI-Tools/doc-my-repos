import {
  handleGetBranding,
  handleResetBranding,
  handleUpdateBranding,
} from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/branding`: current settings, logo version, no bytes. */
export function GET(): Promise<Response> {
  return handleGetBranding();
}

/** `PUT /api/admin/branding` with a partial `{ orgName, pageTitle, ... }` body. */
export function PUT(request: Request): Promise<Response> {
  return handleUpdateBranding(request);
}

/** `DELETE /api/admin/branding`: reset everything, including the logo. */
export function DELETE(): Promise<Response> {
  return handleResetBranding();
}
