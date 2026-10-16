/**
 * Plain-data shapes of comments for the document page and its client island (document-comments
 * tasks 4.1 and 4.2). Dates are ISO strings so the server component can pass them to the island
 * and the island can read them from the API's JSON with the same parser. No React, no database.
 */

import { z } from "zod";

// This module reaches the browser (the island parses API replies with these schemas). Zod's
// "just in time" parsers probe `Function("")`, which the page's Content-Security-Policy (no
// `unsafe-eval`) reports as a violation. Plain parsing is fast enough for these small payloads.
z.config({ jitless: true });

export interface CommentData {
  readonly id: number;
  readonly parentId: number | null;
  readonly authorId: number | null;
  readonly authorLabel: string;
  /** Only present for admins. */
  readonly authorEmail: string | null;
  readonly asOrg: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deleted: boolean;
  readonly resolvedAt: string | null;
}

export interface ThreadData {
  readonly root: CommentData;
  readonly replies: readonly CommentData[];
}

export interface CommentsViewer {
  readonly userId: number;
  readonly isAdmin: boolean;
}

type DateLike = Date | string;
const iso = (value: DateLike): string => (value instanceof Date ? value.toISOString() : value);
const isoOrNull = (value: DateLike | null): string | null => (value === null ? null : iso(value));

export interface CommentLike {
  readonly id: number;
  readonly parentId: number | null;
  readonly authorId: number | null;
  readonly authorLabel: string;
  readonly authorEmail: string | null;
  readonly asOrg: boolean;
  readonly body: string;
  readonly createdAt: DateLike;
  readonly editedAt: DateLike | null;
  readonly deleted: boolean;
  readonly resolvedAt: DateLike | null;
}

export function toCommentData(view: CommentLike): CommentData {
  return {
    id: view.id,
    parentId: view.parentId,
    authorId: view.authorId,
    authorLabel: view.authorLabel,
    authorEmail: view.authorEmail,
    asOrg: view.asOrg,
    body: view.body,
    createdAt: iso(view.createdAt),
    editedAt: isoOrNull(view.editedAt),
    deleted: view.deleted,
    resolvedAt: isoOrNull(view.resolvedAt),
  };
}

export function toThreadData(thread: {
  readonly root: CommentLike;
  readonly replies: readonly CommentLike[];
}): ThreadData {
  return { root: toCommentData(thread.root), replies: thread.replies.map(toCommentData) };
}

const commentSchema = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  authorId: z.number().nullable(),
  authorLabel: z.string(),
  authorEmail: z.string().nullable(),
  asOrg: z.boolean(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
  resolvedAt: z.string().nullable(),
});
const threadSchema = z.object({ root: commentSchema, replies: z.array(commentSchema) });

const changeSchema = z.object({
  comment: commentSchema.nullable(),
  thread: threadSchema.nullable(),
  removed: z.boolean(),
});
const pageSchema = z.object({
  threads: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});

export interface CommentChangeData {
  readonly comment: CommentData | null;
  readonly thread: ThreadData | null;
  readonly removed: boolean;
}

/** Parses the JSON of a successful write, or null when it does not have the expected shape. */
export function parseChange(json: unknown): CommentChangeData | null {
  const parsed = changeSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Parses the JSON of `GET /api/comments`, or null. */
export function parsePage(
  json: unknown,
): { threads: ThreadData[]; nextCursor: string | null } | null {
  const parsed = pageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Applies a write's result to the threads on the page. The thread in the response replaces the
 * one with the same root (or is appended, oldest first, when it is new); a thread that is gone is
 * removed.
 */
export function applyChange(
  threads: readonly ThreadData[],
  change: CommentChangeData,
  commentId: number,
): ThreadData[] {
  if (change.thread !== null) {
    const rootId = change.thread.root.id;
    const found = threads.some((t) => t.root.id === rootId);
    return found
      ? threads.map((t) => (t.root.id === rootId ? change.thread! : t))
      : [...threads, change.thread];
  }
  return threads.filter((t) => t.root.id !== (change.comment?.id ?? commentId));
}

/** Live comments and threads still open, for the heading after a local change. */
export function countThreads(threads: readonly ThreadData[]): { comments: number; open: number } {
  let comments = 0;
  let open = 0;
  for (const t of threads) {
    if (!t.root.deleted) comments += 1;
    comments += t.replies.filter((r) => !r.deleted).length;
    if (t.root.resolvedAt === null) open += 1;
  }
  return { comments, open };
}

export function commentsLabel(count: number): string {
  return count === 1 ? "1 comment" : `${count} comments`;
}

/**
 * What the document page passes to the Comments section. `disabled`: `comments.enabled` is false
 * (no section, no count link). `hidden`: nobody is signed in. `unavailable`: the read failed.
 */
export type DocCommentsData =
  | { readonly status: "disabled" }
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly repo: string;
      readonly path: string;
      readonly threads: readonly ThreadData[];
      readonly nextCursor: string | null;
      readonly counts: { readonly comments: number; readonly openThreads: number };
      readonly viewer: CommentsViewer;
      /** The organization's name for organization comments. */
      readonly orgName: string;
      readonly loadedAt: string;
    };
