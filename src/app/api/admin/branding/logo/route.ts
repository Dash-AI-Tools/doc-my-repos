import { handleRemoveLogo, handleUploadLogo } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `PUT /api/admin/branding/logo`: raw image body, type sniffed from bytes. */
export function PUT(request: Request): Promise<Response> {
  return handleUploadLogo(request);
}

/** `DELETE /api/admin/branding/logo`: remove the logo. */
export function DELETE(): Promise<Response> {
  return handleRemoveLogo();
}
