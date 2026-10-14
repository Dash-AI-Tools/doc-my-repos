import { getDb, type Db } from "@/server/db/client";

import { authenticate, type BootstrapAdmin } from "./login";
import {
  clearedSessionCookieHeader,
  newSessionPayload,
  sessionCookieHeader,
  signSession,
} from "./session";

const GENERIC_FAILURE = "Invalid email or password";

function sessionSecret(): string {
  return process.env.SESSION_SECRET?.trim() ?? "";
}

function bootstrapAdmin(): BootstrapAdmin | null {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (email === "" || password === "") return null;
  return { email, password };
}

function json(data: unknown, status: number, cookies: string[]): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * `POST /api/auth/login` with `{"email","password"}`. Always answers generic 401 on failure
 * (no user enumeration). Sets the signed session cookie on success. Thin route handlers in
 * `src/app/api/auth/` call this; it owns the database access so they stay out of `server/db`
 * (see the layering guard in `src/server/queries/enforcement.test.ts`).
 */
// shortcut: no login rate-limit; add one (e.g. per-IP throttle) when exposed to the open internet.
export async function handleLogin(
  request: Request,
  deps: { db?: Db; sessionSecret?: string; bootstrap?: BootstrapAdmin | null } = {},
): Promise<Response> {
  const secret = deps.sessionSecret ?? sessionSecret();
  if (!secret) {
    return json({ error: "Auth is not configured" }, 500, []);
  }
  let email = "";
  let password = "";
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    if (typeof body.email === "string") email = body.email;
    if (typeof body.password === "string") password = body.password;
  } catch {
    return json({ error: GENERIC_FAILURE }, 401, []);
  }
  let user;
  try {
    user = await authenticate(
      deps.db ?? getDb().db,
      email,
      password,
      deps.bootstrap !== undefined ? deps.bootstrap : bootstrapAdmin(),
    );
  } catch {
    return json({ error: GENERIC_FAILURE }, 401, []);
  }
  if (!user) return json({ error: GENERIC_FAILURE }, 401, []);
  const value = signSession(secret, newSessionPayload(user.id, user.role, user.pwVersion));
  const secure = request.url.startsWith("https://");
  return json({ ok: true, role: user.role }, 200, [sessionCookieHeader(value, secure)]);
}

/** `POST /api/auth/logout`: clears the session cookie. */
export async function handleLogout(): Promise<Response> {
  return json({ ok: true }, 200, [clearedSessionCookieHeader()]);
}
