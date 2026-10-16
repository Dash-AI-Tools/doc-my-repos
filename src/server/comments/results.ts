import type { CommentThread, CommentView } from "../queries";

/**
 * What the comment write handlers return (document-comments design decisions 3 and 4). Routes
 * stay thin: they pass the request in and turn the result into a response with
 * `commentResponse`. Nothing here holds comment text except the changed comment and thread of a
 * success, which the client renders.
 */

export type CommentErrorCode =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "bad_origin"
  | "invalid_json"
  | "invalid"
  | "too_large"
  | "not_a_thread"
  | "document_full"
  | "rate_limited"
  | "not_purgeable"
  | "unavailable";

export interface CommentFailure {
  readonly ok: false;
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503;
  readonly code: CommentErrorCode;
  /** A fixed, safe message. */
  readonly error: string;
  /** The request field to blame, for 400. */
  readonly field?: string;
  /** For 429: seconds until the user may post again. */
  readonly retryAfterSeconds?: number;
  /** For `not_purgeable`: how many of the selected comments are live and were left alone. */
  readonly refused?: number;
}

/** A changed comment and thread; either may be null when it is no longer shown. */
export interface CommentChange {
  readonly ok: true;
  readonly status: 200 | 201;
  /** The comment as it is now (a deleted root with replies is its placeholder); null if gone. */
  readonly comment: CommentView | null;
  /** The whole thread as it is now; null when the thread no longer exists. */
  readonly thread: CommentThread | null;
  /** True when the comment disappeared from the page (deleted with no replies). */
  readonly removed: boolean;
}

export interface PurgeSuccess {
  readonly ok: true;
  readonly status: 200;
  /** How many comments were permanently removed. */
  readonly removed: number;
}

export type CommentResult = CommentChange | CommentFailure;
export type PurgeResult = PurgeSuccess | CommentFailure;

const MESSAGES: Readonly<Record<CommentErrorCode, string>> = {
  not_found: "Not found",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  bad_origin: "Cross-site requests are not allowed",
  invalid_json: "The request body must be valid JSON",
  invalid: "The request is not valid",
  too_large: "The request body is too large",
  not_a_thread: "Only the first comment of a thread can be resolved",
  document_full: "This document has reached the limit of 1,000 comments",
  rate_limited: "You are posting too fast",
  not_purgeable: "Live comments on existing documents cannot be removed permanently",
  unavailable: "Comments are temporarily unavailable",
};

export function failure(
  status: CommentFailure["status"],
  code: CommentErrorCode,
  extra: Partial<Pick<CommentFailure, "field" | "retryAfterSeconds" | "refused">> & {
    message?: string;
  } = {},
): CommentFailure {
  const { message, ...rest } = extra;
  return { ok: false, status, code, error: message ?? MESSAGES[code], ...rest };
}

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie, Origin",
} as const;

/** The JSON response for a handler result: `no-store`, fixed error bodies, `Retry-After` on 429. */
export function commentResponse(result: CommentResult | PurgeResult): Response {
  const headers = new Headers(HEADERS);
  if (result.ok) {
    return new Response(JSON.stringify({ ...result, ok: undefined, status: undefined }), {
      status: result.status,
      headers,
    });
  }
  if (result.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(result.retryAfterSeconds));
  }
  const body: Record<string, unknown> = { error: result.error, code: result.code };
  if (result.field !== undefined) body.field = result.field;
  if (result.retryAfterSeconds !== undefined) body.retryAfterSeconds = result.retryAfterSeconds;
  if (result.refused !== undefined) body.refused = result.refused;
  return new Response(JSON.stringify(body), { status: result.status, headers });
}

/** A JSON body with the comment API's fixed headers (`no-store`, `nosniff`). */
export function commentJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers(HEADERS) });
}

/** 405 with `Allow`, answered before anything is read. */
export function commentsMethodNotAllowed(allow: string): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: allow, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
