import { eq } from "drizzle-orm";

import type { TenantContext, User } from "@docmyrepos/core";

import type { EnvSource } from "../config/env";
import { resolveDb, type Db, type DbInput } from "../db/client";
import { users } from "../db/schema";
import { bearer } from "./bearer";
import { verifyToken } from "../mcp/tokens";
import {
  SESSION_COOKIE,
  newSessionPayload,
  sessionCookieHeader,
  sessionTenant,
  signSession,
  verifySession,
} from "./session";

export interface SessionUserDeps {
  /** The tenant's database, read only when a session has to be checked. */
  readonly db: DbInput;
  /** `SESSION_SECRET`, which signs the session cookie. */
  readonly sessionSecret: string;
  /** For the e2e switch `E2E_AUTH_BYPASS`. Default: `process.env`. */
  readonly env?: EnvSource;
}

/** The value of cookie `name` in a `Cookie` header, or undefined. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** The MCP endpoint: the one path that authenticates with an API token, never the session. */
export const MCP_PATH = "/api/mcp";

/**
 * The signed-in user of a request, by the open-source rules (the default `authenticate` hook).
 * On the MCP endpoint, a valid API token of the tenant (`Authorization: Bearer`), the session
 * cookie being ignored there. Everywhere else, a
 * valid, unexpired session cookie issued for this tenant, whose user exists in the tenant's
 * database, is enabled, and
 * still has the password version and role the cookie was issued with. The row is re-read on every
 * call, so disabling a user or changing a password or role takes effect at once.
 */
export async function sessionUser(
  request: Request,
  tenant: TenantContext,
  deps: SessionUserDeps,
): Promise<User | null> {
  if (new URL(request.url).pathname === MCP_PATH) {
    const presented = bearer(request);
    if (presented === null) return null;
    const verified = await verifyToken(await resolveDb(deps.db), presented);
    return verified.ok ? verified.user : null;
  }
  // Playwright bypass (see the proxy): e2e servers run with E2E_AUTH_BYPASS=1 and exercise
  // content without a login dance. Never set it outside the e2e stack.
  if ((deps.env ?? process.env).E2E_AUTH_BYPASS === "1") {
    // A spec can act as a seeded user by sending `x-e2e-user: <email>` (document-comments e2e);
    // without the header the request is the fixed admin that has no row.
    const email = request.headers.get("x-e2e-user")?.trim().toLowerCase();
    if (email) {
      const db = await resolveDb(deps.db);
      const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const row = found[0];
      return row && !row.disabled ? { id: row.id, email: row.email, role: row.role } : null;
    }
    return { id: 0, email: "e2e-admin@example.com", role: "admin" };
  }
  const payload = verifySession(
    deps.sessionSecret,
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
  );
  // A session is valid only for the tenant it was issued for (user ids repeat across tenants).
  if (!payload || sessionTenant(payload) !== tenant.id) return null;
  const db = await resolveDb(deps.db);
  const rows = await db.select().from(users).where(eq(users.id, payload.uid)).limit(1);
  const row = rows[0];
  if (!row || row.disabled || row.pwVersion !== payload.pwv || row.role !== payload.role) {
    return null;
  }
  return { id: row.id, email: row.email, role: row.role };
}

/** `issueSession` was asked for a user who does not exist or is disabled in the tenant. */
export class SessionUserUnavailableError extends Error {
  constructor() {
    super("the user does not exist or is disabled");
    this.name = "SessionUserUnavailableError";
  }
}

/**
 * A `Set-Cookie` header value that signs user `userId` of `tenant` in, exactly as a password login
 * does: for a host's own sign-in (SSO) that then relies on the core's session, its proxy check and
 * the default `authenticate`. Reads the user's role and password version from the tenant's
 * database; throws `SessionUserUnavailableError` for a missing or disabled user.
 */
export async function issueSessionCookie(
  db: Db,
  tenant: TenantContext,
  userId: number,
  options: { readonly sessionSecret: string; readonly secure: boolean },
): Promise<string> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  if (!row || row.disabled) throw new SessionUserUnavailableError();
  const payload = newSessionPayload(row.id, row.role, row.pwVersion, tenant.id);
  return sessionCookieHeader(signSession(options.sessionSecret, payload), options.secure);
}
