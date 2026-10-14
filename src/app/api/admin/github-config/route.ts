import { handleGithubConfig } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/github-config`: read-only GitHub/sync summary, never any secrets. */
export function GET(): Promise<Response> {
  return handleGithubConfig();
}
