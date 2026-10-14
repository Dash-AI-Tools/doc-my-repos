import { handleLogout } from "@/server/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/auth/logout`: clears the session cookie. */
export function POST(): Promise<Response> {
  return handleLogout();
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}
