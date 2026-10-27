import type { CommentPermissions } from "@docmyrepos/core/internal/comments-view";

import type { Access } from "../auth/access";

interface Comment {
  readonly parentId: number | null;
  readonly authorId: number | null;
  readonly asOrg: boolean;
  readonly deleted: boolean;
}

/**
 * What the viewer may do with `comment`, by the `authorize` hook: edit and delete (`comment.edit`,
 * `comment.delete`), and resolve a thread's root (`comment.resolve`). A deleted comment offers
 * nothing.
 */
export async function permissionsOf(access: Access, comment: Comment): Promise<CommentPermissions> {
  if (comment.deleted) return { edit: false, delete: false, resolve: false };
  const resource = {
    kind: "comment",
    authorId: comment.authorId,
    asOrganization: comment.asOrg,
  } as const;
  const [edit, remove, resolve] = await Promise.all([
    access.can("comment.edit", resource),
    access.can("comment.delete", resource),
    comment.parentId === null ? access.can("comment.resolve", resource) : false,
  ]);
  return { edit, delete: remove, resolve };
}

/** `comment` with the viewer's permissions on it. */
export async function withPermissions<C extends Comment>(
  access: Access,
  comment: C,
): Promise<C & { can: CommentPermissions }> {
  return { ...comment, can: await permissionsOf(access, comment) };
}

/** Every comment of `thread` with the viewer's permissions on it. */
export async function threadWithPermissions<C extends Comment>(
  access: Access,
  thread: { readonly root: C; readonly replies: readonly C[] },
): Promise<{
  root: C & { can: CommentPermissions };
  replies: (C & { can: CommentPermissions })[];
}> {
  const [root, ...replies] = await Promise.all(
    [thread.root, ...thread.replies].map((comment) => withPermissions(access, comment)),
  );
  return { root: root!, replies };
}
