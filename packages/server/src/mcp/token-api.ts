import "server-only";

import { type Access, legacyAccess } from "../auth/access";
import type { CurrentUser } from "../auth/current-user";
import { type Db, type DbInput, resolveDb } from "../db/client";
import { logger, type Logger } from "../log";
import { requireSameOrigin } from "../same-origin";
import { mcpEnabled } from "../workspace";
import { createToken, listAllTokens, listTokens, revokeToken } from "./tokens";

/**
 * Handlers for the token management APIs (mcp-agent-access spec `agent-tokens`, design decision 3).
 * The route files under `src/app/api/account/tokens` and `src/app/api/admin/tokens` are thin
 * wrappers; the logic is here so it can be tested without Next.js.
 *
 * These are ordinary session routes: the user comes from the session cookie only (the default
 * `authenticate` accepts API tokens on the MCP endpoint alone), so an `Authorization: Bearer`
 * token alone gets 401 here (a token can never create, list or revoke tokens). Check order for every handler, each step ending the request with its status:
 *   1. the MCP switch (404 when off, before anything is revealed)   2. the session (401, 403)
 *   3. writes only: same-origin JSON (403)                           4. the body (400, 413)
 *   5. the operation (400, 404, 409).
 *
 * Every answer is `no-store`: the creation answer holds the only copy of a token. Logs carry the
 * action and ids under `ref` (the logger redacts any field named like a credential) and never a
 * token, a name or an email.
 */

/** Largest request body read, in characters: a name of 60 characters and an expiry fit easily. */
export const MAX_BODY_CHARS = 4096;

export interface TokenApiDeps {
  /** The database. Default: the shared handle. */
  readonly db: DbInput;
  /** Whether the MCP endpoint is on. Default: `mcp.enabled` from the workspace settings. */
  readonly enabled?: () => boolean | Promise<boolean>;
  /** Default: the process logger. */
  readonly log?: Logger;
  /** Resolves the signed-in user (default `requireUser` or `requireAdmin`). Tests only. */
  readonly user?: (db: Db) => Promise<CurrentUser>;
  /**
   * Who is asking and what they may do (routes: the request context's `authenticate` and
   * `authorize`). Default: the open-source rules over the session cookie, or over `user`.
   */
  readonly access?: Access;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: HEADERS });
}

const fail = (status: number, error: string) => json(status, { error });

export function tokenMethodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { ...HEADERS, Allow: allow } });
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

interface Ctx {
  readonly db: Db;
  readonly user: CurrentUser;
  readonly log: Logger;
  readonly access: Access;
}

/** Steps 1 to 3. */
async function prepare(
  request: Request,
  deps: TokenApiDeps,
  mode: { admin: boolean; write: boolean },
): Promise<Ctx | Response> {
  try {
    if (!(await (deps.enabled ?? mcpEnabled)())) return fail(404, "Not found");
  } catch {
    return fail(503, "Unavailable");
  }
  let db: Db;
  let user: CurrentUser;
  let access: Access;
  try {
    db = await resolveDb(deps.db);
    const testUser = deps.user;
    access = deps.access ?? legacyAccess(db, testUser ? async () => testUser(db) : undefined);
    user = await access.user();
    // Listing or revoking anyone's tokens is `token.manage_any`; a user's own, `token.manage_own`.
    const allowed = mode.admin
      ? await access.can("token.manage_any", { kind: "token", ownerId: user.id })
      : await access.can("token.manage_own", { kind: "token", ownerId: user.id });
    if (!allowed) return fail(403, "Forbidden");
  } catch (error) {
    const status = statusOf(error);
    if (status === 401) return fail(401, "Unauthorized");
    if (status === 403) return fail(403, "Forbidden");
    return fail(503, "Unavailable");
  }
  if (mode.write) {
    const origin = requireSameOrigin(request);
    if (!origin.ok) return fail(403, origin.error);
  }
  return { db, user, log: deps.log ?? logger, access };
}

const ID = /^[1-9]\d{0,9}$/;

function parseId(raw: string): number | null {
  return typeof raw === "string" && ID.test(raw) && Number(raw) <= 2_147_483_647
    ? Number(raw)
    : null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_CHARS * 4) return fail(413, "body: too large");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail(400, "body: could not be read");
  }
  if (text.length > MAX_BODY_CHARS) return fail(413, "body: too large");
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(400, "body: must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch {
    return fail(400, "body: invalid JSON");
  }
}

// ---------------------------------------------------------------------------------------------
// A user's own tokens

/** `GET /api/account/tokens`: the signed-in user's tokens. */
export async function handleListOwnTokens(request: Request, deps: TokenApiDeps): Promise<Response> {
  const ctx = await prepare(request, deps, { admin: false, write: false });
  if (ctx instanceof Response) return ctx;
  try {
    return json(200, { tokens: await listTokens(ctx.db, ctx.user.id) });
  } catch {
    return fail(503, "Unavailable");
  }
}

/** `POST /api/account/tokens` with `{ name, expiryDays }`. 201 with the full token, once. */
export async function handleCreateToken(request: Request, deps: TokenApiDeps): Promise<Response> {
  const ctx = await prepare(request, deps, { admin: false, write: true });
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  try {
    const result = await createToken(ctx.db, ctx.user.id, {
      name: body.name,
      expiryDays: body.expiryDays,
    });
    if (!result.ok) return fail(result.status, result.error);
    ctx.log.info("mcp.token.created", { ref: result.view.id, userId: ctx.user.id });
    ctx.access.emit({
      name: "token.created",
      payload: { tokenId: result.view.id, ownerId: ctx.user.id },
    });
    return json(201, { token: result.token, view: result.view });
  } catch {
    return fail(503, "Unavailable");
  }
}

/** `DELETE /api/account/tokens/:id`: revokes the user's own token; another user's is 404. */
export async function handleRevokeOwnToken(
  request: Request,
  rawId: string,
  deps: TokenApiDeps,
): Promise<Response> {
  const ctx = await prepare(request, deps, { admin: false, write: true });
  if (ctx instanceof Response) return ctx;
  const id = parseId(rawId);
  if (id === null) return fail(404, "Not found");
  try {
    const result = await revokeToken(ctx.db, id, { id: ctx.user.id, any: false });
    if (!result.ok) return fail(404, "Not found");
    ctx.log.info("mcp.token.revoked", { ref: id, userId: ctx.user.id, byAdmin: false });
    if (result.revoked) {
      ctx.access.emit({ name: "token.revoked", payload: { tokenId: id, ownerId: result.ownerId } });
    }
    return json(200, { revoked: true });
  } catch {
    return fail(503, "Unavailable");
  }
}

// ---------------------------------------------------------------------------------------------
// Administrators

/** `GET /api/admin/tokens`: every user's tokens, with their owner. Admin only. */
export async function handleListAllTokens(request: Request, deps: TokenApiDeps): Promise<Response> {
  const ctx = await prepare(request, deps, { admin: true, write: false });
  if (ctx instanceof Response) return ctx;
  try {
    return json(200, { tokens: await listAllTokens(ctx.db) });
  } catch {
    return fail(503, "Unavailable");
  }
}

/** `DELETE /api/admin/tokens/:id`: revokes any user's token. Admin only. */
export async function handleRevokeAnyToken(
  request: Request,
  rawId: string,
  deps: TokenApiDeps,
): Promise<Response> {
  const ctx = await prepare(request, deps, { admin: true, write: true });
  if (ctx instanceof Response) return ctx;
  const id = parseId(rawId);
  if (id === null) return fail(404, "Not found");
  try {
    const result = await revokeToken(ctx.db, id, { id: ctx.user.id, any: true });
    if (!result.ok) return fail(404, "Not found");
    ctx.log.info("mcp.token.revoked", { ref: id, userId: ctx.user.id, byAdmin: true });
    if (result.revoked) {
      ctx.access.emit({ name: "token.revoked", payload: { tokenId: id, ownerId: result.ownerId } });
    }
    return json(200, { revoked: true });
  } catch {
    return fail(503, "Unavailable");
  }
}
