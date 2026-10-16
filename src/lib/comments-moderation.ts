/**
 * Plain-data shapes and pure helpers for the admin Comments page (document-comments task 5.1).
 * No React, no database: the server loader fills these and the page and island read them.
 */

export type ModerationState = "live" | "deleted" | "orphaned" | "blocked";

export const MODERATION_STATES: readonly ModerationState[] = [
  "live",
  "deleted",
  "orphaned",
  "blocked",
];

export const EXCERPT_CHARS = 200;

export interface ModerationRow {
  readonly id: number;
  readonly isReply: boolean;
  readonly state: ModerationState;
  readonly githubRepoId: number;
  readonly path: string;
  /** `owner/name`, or null when the repository no longer exists. */
  readonly repoLabel: string | null;
  readonly repoHref: string | null;
  /** The in-app page of the document, or null when it is gone or has no page. */
  readonly docHref: string | null;
  readonly authorLabel: string;
  /** Null after the author's account was removed. */
  readonly authorEmail: string | null;
  readonly asOrg: boolean;
  readonly excerpt: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deleted: boolean;
  readonly deletedByAdmin: boolean;
  /** For an orphaned comment: how many comments the same document has stored (all orphaned). */
  readonly groupCount: number | null;
}

export interface ModerationFilters {
  readonly state: ModerationState | null;
  readonly githubRepoId: number | null;
  readonly cursor: string | null;
}

export type ModerationData =
  | {
      readonly status: "ready";
      readonly enabled: boolean;
      readonly filters: ModerationFilters;
      readonly rows: readonly ModerationRow[];
      readonly nextCursor: string | null;
      readonly now: string;
    }
  | { readonly status: "unavailable" };

/**
 * The first 200 code points of a comment, whitespace runs (line breaks included) folded to one
 * space, with an ellipsis when cut. Plain text: callers render it as text, never as markup.
 */
export function excerptOf(body: string): string {
  const folded = body.replace(/\s+/g, " ").trim();
  const chars = Array.from(folded);
  return chars.length <= EXCERPT_CHARS
    ? folded
    : `${chars.slice(0, EXCERPT_CHARS).join("").trimEnd()}…`;
}

/** The page address for a set of filters plus extra query values (omitted when null). */
export function moderationHref(
  filters: Partial<ModerationFilters>,
  extra: Readonly<Record<string, string | number | null>> = {},
): string {
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.githubRepoId) params.set("repo", String(filters.githubRepoId));
  if (filters.cursor) params.set("cursor", filters.cursor);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== null) params.set(key, String(value));
  }
  const query = params.toString();
  return query === "" ? "/admin/comments" : `/admin/comments?${query}`;
}

export function commentCount(n: number): string {
  return n === 1 ? "1 comment" : `${n.toLocaleString("en-US")} comments`;
}
