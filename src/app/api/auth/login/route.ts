import { handleLogin } from "@/server/auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `POST /api/auth/login` with `{"email","password"}`. Generic 401 on failure, signed session
 * cookie on success. All logic lives in `src/server/auth/service.ts`.
 */
export function POST(request: Request): Promise<Response> {
  return handleLogin(request);
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
