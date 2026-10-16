import type { CommentData, DocCommentsData, ThreadData } from "@/lib/comments-view";

/** Shared builders for the comments component tests. */
export const NOW = "2026-10-10T12:00:00.000Z";

export function comment(over: Partial<CommentData> & { id: number }): CommentData {
  return {
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
}

export function thread(root: CommentData, replies: CommentData[] = []): ThreadData {
  return { root, replies };
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
    threads,
    nextCursor: null,
    counts: { comments, openThreads: threads.filter((t) => t.root.resolvedAt === null).length },
    viewer: { userId: 2, isAdmin: false },
    orgName: "Organization",
    loadedAt: NOW,
    ...over,
  };
}
