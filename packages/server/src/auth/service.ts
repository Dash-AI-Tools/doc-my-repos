import { type DbInput, resolveDb } from "../db/client";
import type { DomainEventInput } from "@docmyrepos/core";

import { authenticate, type BootstrapAdmin } from "./login";
import {
  clearedSessionCookieHeader,
  newSessionPayload,
  sessionCookieHeader,
  signSession,
} from "./session";

const GENERIC_FAILURE = "Invalid email or password";

type Source = Readonly<Record<string, string | undefined>>;

function sessionSecret(source: Source): string {
  return source.SESSION_SECRET?.trim() ?? "";
}

function bootstrapAdmin(source: Source): BootstrapAdmin | null {
  const email = source.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const password = source.ADMIN_PASSWORD ?? "";
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
 * (see the layering guard in `packages/server/src/queries/enforcement.test.ts`).
 */
// shortcut: no login rate-limit; add one (e.g. per-IP throttle) when exposed to the open internet.
export async function handleLogin(
  request: Request,
  deps: {
    db: DbInput;
    sessionSecret?: string;
    bootstrap?: BootstrapAdmin | null;
    /** The startup configuration the secret and bootstrap admin come from. Default: the env. */
    source?: Source;
    /** The request's tenant, named in the session. Default: the built-in tenant. */
    tenantId?: string;
    /** Receives `auth.login_succeeded` and `auth.login_failed`. */
    emit?: (event: DomainEventInput) => void;
  },
): Promise<Response> {
  const source = deps.source ?? process.env;
  const secret = deps.sessionSecret ?? sessionSecret(source);
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
      await resolveDb(deps.db),
      email,
      password,
      deps.bootstrap !== undefined ? deps.bootstrap : bootstrapAdmin(source),
    );
  } catch {
    deps.emit?.({ name: "auth.login_failed", payload: {}, actorId: null });
    return json({ error: GENERIC_FAILURE }, 401, []);
  }
  if (!user) {
    deps.emit?.({ name: "auth.login_failed", payload: {}, actorId: null });
    return json({ error: GENERIC_FAILURE }, 401, []);
  }
  const value = signSession(
    secret,
    newSessionPayload(user.id, user.role, user.pwVersion, deps.tenantId),
  );
  const secure = request.url.startsWith("https://");
  deps.emit?.({ name: "auth.login_succeeded", payload: { userId: user.id }, actorId: user.id });
  return json({ ok: true, role: user.role }, 200, [sessionCookieHeader(value, secure)]);
}

/** `POST /api/auth/logout`: clears the session cookie. */
export async function handleLogout(
  deps: {
    /** The user signing out, if any. */
    readonly user?: () => Promise<{ id: number } | null>;
    /** Receives `auth.logout`. */
    readonly emit?: (event: DomainEventInput) => void;
  } = {},
): Promise<Response> {
  if (deps.emit) {
    const user = await (deps.user?.() ?? Promise.resolve(null)).catch(() => null);
    deps.emit({
      name: "auth.logout",
      payload: { userId: user?.id ?? null },
      actorId: user?.id ?? null,
    });
  }
  return json({ ok: true }, 200, [clearedSessionCookieHeader()]);
}
