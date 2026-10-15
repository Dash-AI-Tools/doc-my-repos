/**
 * Branding input validation (org-branding 1.1). Pure: no React, no I/O, safe for server and
 * client code, so the admin handlers and the read path cannot disagree about what is valid.
 *
 * Names (1-60) and titles (1-70) are trimmed plain text: no control characters and no
 * bidi-override characters. Angle brackets are allowed (shown as text by React, never as
 * markup). Colors are lower-cased and exactly `#rrggbb`.
 */

export const MAX_ORG_NAME_LENGTH = 60;
export const MAX_PAGE_TITLE_LENGTH = 70;

export const BRAND_COLOR_RE = /^#[0-9a-f]{6}$/;

/** C0/C1 controls, DEL, and bidi overrides/isolates/embedding marks. */
const FORBIDDEN_TEXT_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export type TextResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: string };

function parseText(value: unknown, max: number, field: string): TextResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be text` };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (Array.from(trimmed).length > max)
    return { ok: false, error: `${field} must be at most ${max} characters` };
  if (FORBIDDEN_TEXT_RE.test(trimmed))
    return {
      ok: false,
      error: `${field} must not contain control or direction-override characters`,
    };
  return { ok: true, value: trimmed };
}

/** Organization name: trimmed 1-60 chars of plain text. Null/empty means "use default". */
export function parseOrgName(value: unknown): TextResult {
  return parseText(value, MAX_ORG_NAME_LENGTH, "organization name");
}

/** Page title: trimmed 1-70 chars of plain text. Null/empty means "use default". */
export function parsePageTitle(value: unknown): TextResult {
  return parseText(value, MAX_PAGE_TITLE_LENGTH, "page title");
}

export type ColorResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: string };

/** Brand color: lower-cased `#rrggbb`. Null/empty means "use default". */
export function parseBrandColor(value: unknown): ColorResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "color must be text" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  const lower = trimmed.toLowerCase();
  if (!BRAND_COLOR_RE.test(lower)) return { ok: false, error: "color must be exactly #rrggbb" };
  return { ok: true, value: lower };
}
