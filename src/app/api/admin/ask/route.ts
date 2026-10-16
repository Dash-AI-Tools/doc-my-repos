import { handleGetAsk, handleSaveAsk } from "@/server/admin/ask";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/ask`: the saved choice, each provider's availability, and the current state. */
export function GET(): Promise<Response> {
  return handleGetAsk();
}

/** `PUT /api/admin/ask` with `{ enabled, provider?, model? }`. */
export function PUT(request: Request): Promise<Response> {
  return handleSaveAsk(request);
}
