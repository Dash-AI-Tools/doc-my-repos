import { handleAsk } from "@/server/ask/handler";

/**
 * `POST /api/ask`: asks a question about the documentation and streams the answer as server-sent
 * events. Logic lives in `src/server/ask/handler.ts`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleAsk(request);
}

const notAllowed = () =>
  new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export const GET = notAllowed;
export const HEAD = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
