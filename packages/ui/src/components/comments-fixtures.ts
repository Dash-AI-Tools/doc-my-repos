import type {
  CommentData,
  DocCommentsData,
  ThreadData,
} from "@docmyrepos/core/internal/comments-view";

/** Shared builders for the comments component tests. */
export const NOW = "2026-10-10T12:00:00.000Z";

/** The viewer of the fixtures unless a test passes its own: user 2, not an admin. */
export const VIEWER = { userId: 2, isAdmin: false } as const;

/**
 * What `viewer` may do with `c` under the open-source rules: the permissions the server would
 * send (the server decides them with the `authorize` hook; see `comments/permissions.ts`).
 */
export function permissionsFor(
  c: Pick<CommentData, "parentId" | "authorId" | "asOrg" | "deleted">,
  viewer: { userId: number; isAdmin: boolean } = VIEWER,
): CommentData["can"] {
  if (c.deleted) return { edit: false, delete: false, resolve: false };
  const own = c.asOrg ? viewer.isAdmin : c.authorId === viewer.userId;
  return {
    edit: own,
    delete: own,
    resolve: c.parentId === null && (viewer.isAdmin || c.authorId === viewer.userId),
  };
}

export function comment(over: Partial<CommentData> & { id: number }): CommentData {
  const base = {
    parentId: null,
    authorId: 2,
    authorLabel: "ana",
    authorEmail: null,
    asOrg: false,
    body: `text ${over.id}`,
    createdAt: "2026-10-10T11:00:00.000Z",
    editedAt: null,
    deleted: false,
    resolvedAt: null,
    ...over,
  };
  return { ...base, can: over.can ?? permissionsFor(base) };
}

export function thread(root: CommentData, replies: CommentData[] = []): ThreadData {
  return { root, replies };
}

/** `threads` with every comment's permissions recomputed for `viewer`. */
export function forViewer(
  threads: readonly ThreadData[],
  viewer: { userId: number; isAdmin: boolean },
): ThreadData[] {
  const fix = (c: CommentData): CommentData => ({ ...c, can: permissionsFor(c, viewer) });
  return threads.map((t) => ({ root: fix(t.root), replies: t.replies.map(fix) }));
}

export function ready(
  threads: ThreadData[],
  over: Partial<Extract<DocCommentsData, { status: "ready" }>> = {},
): Extract<DocCommentsData, { status: "ready" }> {
  const comments = threads.reduce(
    (n, t) => n + (t.root.deleted ? 0 : 1) + t.replies.filter((r) => !r.deleted).length,
    0,
  );
  return {
    status: "ready",
    repo: "acme/api",
    path: "docs/a.md",
    threads: over.viewer ? forViewer(threads, over.viewer) : threads,
    nextCursor: null,
    counts: { comments, openThreads: threads.filter((t) => t.root.resolvedAt === null).length },
    viewer: { userId: 2, isAdmin: false },
    orgName: "Organization",
    loadedAt: NOW,
    ...over,
    ...(over.viewer ? { threads: forViewer(over.threads ?? threads, over.viewer) } : {}),
  };
}
