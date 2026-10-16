import { handleTestGithub } from "@/server/admin/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/admin/settings/test`: tries the GitHub App settings; never saves anything. */
export function POST(request: Request): Promise<Response> {
  return handleTestGithub(request);
}
