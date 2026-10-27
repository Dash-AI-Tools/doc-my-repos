import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";

import { DEFAULT_TENANT_ID, WORKSPACE, defaultAuthorize } from "@docmyrepos/core";

import { getDb, type Db } from "../db/client";
import { users } from "../db/schema";

import { SESSION_COOKIE, sessionTenant, verifySession, type SessionPayload } from "./session";

export interface CurrentUser {
  id: number;
  email: string;
  role: "admin" | "user";
}

function sessionSecret(): string {
  return process.env.SESSION_SECRET?.trim() ?? "";
}

/** The logged-in user, or null. Re-reads the row so disable/reset take effect immediately. */
export async function getCurrentUser(db: Db | null = null): Promise<CurrentUser | null> {
  // Playwright bypass (see proxy.ts): e2e servers run with E2E_AUTH_BYPASS=1 and exercise
  // content without a login dance. Never set it outside the e2e stack.
  if (process.env.E2E_AUTH_BYPASS === "1") {
    // A spec can act as a seeded user by sending `x-e2e-user: <email>` (document-comments e2e);
    // without the header the request is the fixed admin that has no row.
    const email = (await headers()).get("x-e2e-user")?.trim().toLowerCase();
    if (email) {
      const found = await (db ?? getDb().db)
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = found[0];
      return row && !row.disabled ? { id: row.id, email: row.email, role: row.role } : null;
    }
    return { id: 0, email: "e2e-admin@example.com", role: "admin" };
  }
  const store = await cookies();
  const payload: SessionPayload | null = verifySession(
    sessionSecret(),
    store.get(SESSION_COOKIE)?.value,
  );
  // This path reads the built-in tenant's database, so it accepts only that tenant's sessions.
  if (!payload || sessionTenant(payload) !== DEFAULT_TENANT_ID) return null;
  const rows = await (db ?? getDb().db)
    .select()
    .from(users)
    .where(eq(users.id, payload.uid))
    .limit(1);
  const row = rows[0];
  if (!row || row.disabled || row.pwVersion !== payload.pwv || row.role !== payload.role) {
    return null;
  }
  return { id: row.id, email: row.email, role: row.role };
}

export async function requireUser(db: Db | null = null): Promise<CurrentUser> {
  const user = await getCurrentUser(db);
  if (!user) {
    const error = new Error("unauthorized") as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return user;
}

export async function requireAdmin(db: Db | null = null): Promise<CurrentUser> {
  const user = await requireUser(db);
  if (!defaultAuthorize(user, "admin.manage", WORKSPACE)) {
    const error = new Error("forbidden") as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  return user;
}

/**
 * Maps `requireUser`/`requireAdmin` failures to responses (401/403 JSON, generic messages).
 * Anything else is a 500 without detail.
 */
export function authErrorResponse(error: unknown): Response {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error.status === 401 || error.status === 403)
      ? error.status
      : 500;
  const message = status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : "Internal error";
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
