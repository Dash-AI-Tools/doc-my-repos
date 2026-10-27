/**
 * Pure helpers for document comments (document-comments design decisions 5 and 6). No React, no
 * database: safe for server and client code.
 *
 * Comment text is untrusted input from signed-in users that other users' browsers render. It is
 * stored cleaned (`cleanComment`) and shown as text; the only markup produced is links, found by
 * `linkify`, which returns tokens (never HTML) for React to render as `<a>` elements.
 */

import { MAX_URL, safeExternalUrl } from "./okf-meta";

export const MAX_COMMENT_LENGTH = 4000;

/** C0 (tab and line feed kept), DEL, C1, bidi marks/overrides/isolates, zero-width marks, BOM. */
const STRIPPED = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]",
  "g",
);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const SEPARATORS = new RegExp("\\r\\n?|[\\u2028\\u2029]", "g");

export type CleanCommentResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "empty" | "too_long" };

/**
 * Cleans comment text for storage: CRLF/CR/LS/PS become `\\n`, control characters (tab and line
 * feed kept), bidirectional controls, zero-width marks and lone surrogates are removed, and the
 * ends are trimmed. The result must be 1 to 4,000 code points (not UTF-16 units).
 */
export function cleanComment(input: string): CleanCommentResult {
  // An absurdly long input cannot become valid; do not scan all of it.
  if (input.length > MAX_COMMENT_LENGTH * 8) return { ok: false, reason: "too_long" };
  const text = input
    .replace(SEPARATORS, "\n")
    .replace(LONE_SURROGATE, "")
    .replace(STRIPPED, "")
    .trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (commentLength(text) > MAX_COMMENT_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

/** Number of code points in `text`, as the 4,000 limit counts them. */
export function commentLength(text: string): number {
  return Array.from(text).length;
}

/** The part of an email before the `@`, or the whole (trimmed) email when that part is empty. */
export function displayName(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  const local = at === -1 ? trimmed : trimmed.slice(0, at);
  return local === "" ? trimmed : local;
}

export type CommentToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

const URL_START = /https?:\/\//gi;
const URL_END = /[\s<>"`]/;
const TRAILING = /[.,;:!?'"*_~)\]}>]/;
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** Drops trailing punctuation, and a closing bracket only when it has no opener in the address. */
function trimTrailing(candidate: string): string {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1]!;
    if (!TRAILING.test(last)) break;
    const opener = CLOSERS[last];
    if (opener !== undefined) {
      const body = candidate.slice(0, end);
      const opens = body.split(opener).length - 1;
      const closes = body.split(last).length - 1;
      if (closes <= opens) break;
    }
    end -= 1;
  }
  return candidate.slice(0, end);
}

/**
 * Splits comment text into text and link tokens. A link is an `http://` or `https://` run up to
 * whitespace, trimmed of trailing punctuation, at most 2,048 characters, with no credentials,
 * accepted by `safeExternalUrl`. Anything else stays text, so `javascript:` and `data:` are never
 * links. The tokens' `text` values joined give back the input exactly.
 */
export function linkify(input: string): CommentToken[] {
  const tokens: CommentToken[] = [];
  let cursor = 0;
  const push = (token: CommentToken) => {
    if (token.text === "") return;
    const last = tokens[tokens.length - 1];
    if (token.kind === "text" && last?.kind === "text") {
      tokens[tokens.length - 1] = { kind: "text", text: last.text + token.text };
    } else tokens.push(token);
  };
  URL_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_START.exec(input)) !== null) {
    const start = match.index;
    if (start < cursor) continue;
    // Not the middle of a word (`xhttp://`) or of a longer scheme.
    if (start > 0 && /[A-Za-z0-9+.-]/.test(input[start - 1]!)) continue;
    let end = start;
    while (end < input.length && !URL_END.test(input[end]!)) end += 1;
    const candidate = trimTrailing(input.slice(start, end));
    const href =
      candidate.length > 0 && candidate.length <= MAX_URL ? safeExternalUrl(candidate) : null;
    if (href === null) {
      // Leave it as text and resume after it so a long run is not rescanned from every offset.
      URL_START.lastIndex = Math.max(end, start + 1);
      continue;
    }
    push({ kind: "text", text: input.slice(cursor, start) });
    push({ kind: "link", text: candidate, href });
    cursor = start + candidate.length;
    URL_START.lastIndex = cursor;
  }
  push({ kind: "text", text: input.slice(cursor) });
  return tokens;
}
