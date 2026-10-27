import "server-only";
import type { DomainEventInput } from "@docmyrepos/core";

import { type Db, type DbInput, resolveDb } from "../db/client";
import { logger, type Logger } from "../log";
import { checkOrigin } from "../same-origin";
import { mcpEnabled } from "../workspace";
import { sharedLimiter, type Limiter } from "./limits";
import { requestOrigin } from "./origin";
import { handleWithSdk, type AdapterOptions } from "./server";
import type { ToolContext } from "./tool-types";
import { bearer } from "../auth/bearer";
import { verifyToken } from "./tokens";

/**
 * The MCP endpoint's request pipeline (mcp-agent-access spec `mcp-server`, design decision 4).
 * The route file is a thin wrapper; the logic is here so it can be tested without Next.js.
 *
 * Checks run in this order, before anything of the request is parsed, each ending the request with
 * its own status and a fixed body:
 *   1. the MCP switch (404 for every request when an administrator turned it off)
 *   2. the method (405 with `Allow: POST` for anything else, GET and DELETE included)
 *   3. the Origin (403 for a foreign one: agents send none, so this only stops browsers, DNS
 *      rebinding and cross-site calls)
 *   4. the size (413 over 256 KB, by `Content-Length` and again while reading the body)
 *   5. the bearer token (401 with `WWW-Authenticate: Bearer`)
 *   6. concurrency (429 per token, 503 per process, both with `Retry-After`)
 *   7. the MCP protocol itself, through the SDK adapter.
 *
 * The session cookie is never read here: a token is the only credential this route knows, so a
 * browser request carries none. Every answer is `no-store`. Logs carry a fixed reason, a status and
 * the token's row id (as `ref`), never a token, an argument or any text of the request.
 */

export const MAX_BODY_BYTES = 256 * 1024;
export const RETRY_AFTER_SECONDS = 1;
export const ALLOW = "POST";

export interface McpDeps extends AdapterOptions {
  /** The database: the tenant's (through the database adapter) or a test database. */
  readonly db: DbInput;
  /** The request's tenant, part of every in-process limit key. Default: the built-in tenant. */
  readonly tenantId?: string;
  /** Receives the domain events of tool calls. */
  readonly emit?: (event: DomainEventInput) => void;
  /** Whether the endpoint is on. Default: `mcp.enabled` from the workspace settings. */
  readonly enabled?: () => boolean | Promise<boolean>;
  readonly log?: Logger;
  readonly limiter?: Limiter;
  readonly now?: () => Date;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

function refuse(
  log: Logger,
  status: number,
  error: string,
  reason: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Response {
  log.warn("mcp.request.refused", { status, reason, ...extra });
  return Response.json({ error }, { status, headers: { ...HEADERS, ...headers } });
}

type Body = { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" };

/** Reads the body, giving up as soon as it passes `max` bytes. */
async function readBody(request: Request, max: number): Promise<Body> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: "too_large" };
  if (request.body === null) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const log = deps.log ?? logger;

  // 1. The switch.
  try {
    if (!(await (deps.enabled ?? mcpEnabled)())) {
      return refuse(log, 404, "Not found", "disabled");
    }
  } catch {
    return refuse(log, 503, "Unavailable", "unavailable", { "Retry-After": "5" });
  }

  // 2. The method.
  if (request.method !== "POST") {
    return refuse(log, 405, "Method not allowed: use POST", "method", { Allow: ALLOW });
  }

  // 3. The Origin.
  const origin = checkOrigin(request);
  if (!origin.ok) return refuse(log, 403, "Forbidden", "origin");

  // 4. The size, from the header first so a large body is never read.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse(log, 413, "Request too large", "too_large");
  }

  // 5. The token.
  const presented = bearer(request);
  if (presented === null) {
    return refuse(log, 401, "Unauthorized", "no_credential", {
      "WWW-Authenticate": 'Bearer realm="DocMyRepos"',
    });
  }
  let db: Db;
  try {
    db = await resolveDb(deps.db);
  } catch {
    return refuse(log, 503, "Unavailable", "unavailable", { "Retry-After": "5" });
  }
  let verified;
  try {
    verified = await verifyToken(db, presented, deps.now?.());
  } catch {
    return refuse(log, 503, "Unavailable", "unavailable", { "Retry-After": "5" });
  }
  if (!verified.ok) {
    return refuse(
      log,
      401,
      "Unauthorized",
      "bad_credential",
      { "WWW-Authenticate": 'Bearer realm="DocMyRepos", error="invalid_token"' },
      { why: verified.reason },
    );
  }

  // 6. Concurrency.
  const slot = (deps.limiter ?? sharedLimiter()).acquire(verified.tokenId, deps.tenantId);
  if (!slot.ok) {
    return refuse(
      log,
      slot.status,
      slot.status === 429 ? "Too many requests" : "Busy",
      slot.status === 429 ? "token_busy" : "process_busy",
      { "Retry-After": String(RETRY_AFTER_SECONDS) },
      { ref: verified.tokenId },
    );
  }

  try {
    // The body is read with the limit enforced on the stream, then handed to the SDK as text.
    const body = await readBody(request, MAX_BODY_BYTES);
    if (!body.ok) {
      return body.reason === "too_large"
        ? refuse(log, 413, "Request too large", "too_large", {}, { ref: verified.tokenId })
        : refuse(log, 400, "Bad request", "unreadable", {}, { ref: verified.tokenId });
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const forwarded = new Request(request.url, { method: "POST", headers, body: body.text });
    const ctx: ToolContext = {
      db,
      user: verified.user,
      tokenRef: verified.tokenId,
      origin: requestOrigin(request),
      log,
      now: deps.now ?? (() => new Date()),
      emit: deps.emit,
    };
    // 7. The protocol.
    const response = await handleWithSdk(forwarded, ctx, deps);
    const out = new Response(response.body, response);
    out.headers.set("Cache-Control", "no-store");
    out.headers.set("X-Content-Type-Options", "nosniff");
    return out;
  } catch {
    return refuse(log, 500, "Internal error", "internal", {}, { ref: verified.tokenId });
  } finally {
    slot.release();
  }
}
