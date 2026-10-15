import { handleLogoRequest } from "@/server/branding/serve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/branding/logo`: the portal logo, public (the sign-in page shows it). */
export function GET(request: Request): Promise<Response> {
  return handleLogoRequest(request);
}

/** Same headers without the body. */
export function HEAD(request: Request): Promise<Response> {
  return handleLogoRequest(request);
}
