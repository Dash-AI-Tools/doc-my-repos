import { handleTestAsk } from "@/server/admin/ask";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/admin/ask/test` with `{ provider, model }`: one fixed request, one fixed result word. */
export function POST(request: Request): Promise<Response> {
  return handleTestAsk(request);
}
