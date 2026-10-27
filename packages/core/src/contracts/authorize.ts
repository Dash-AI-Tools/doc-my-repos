import type { Action, Resource } from "./authorization";
import type { User } from "./user";

/**
 * The open-source permission rules, as one pure function (the default `authorize` hook):
 * - administrators manage the workspace, moderate comments, see comment authors' emails, post as
 *   the organization and manage everyone's tokens;
 * - any signed-in user reads content, asks, comments and manages their own tokens;
 * - a comment is edited or deleted by its author, or by an administrator when it was posted as the
 *   organization; it is resolved by its author or any administrator.
 * Signed-out visitors may do nothing.
 */
export function defaultAuthorize(user: User | null, action: Action, resource: Resource): boolean {
  if (user === null) return false;
  const admin = user.role === "admin";
  switch (action) {
    case "admin.manage":
    case "comment.create_as_organization":
    case "comment.moderate":
    case "comment.view_author_email":
    case "token.manage_any":
      return admin;
    case "content.read":
    case "ask.use":
    case "comment.create":
      return true;
    case "comment.edit":
    case "comment.delete":
      if (resource.kind !== "comment") return false;
      return resource.asOrganization ? admin : resource.authorId === user.id;
    case "comment.resolve":
      if (resource.kind !== "comment") return false;
      return admin || resource.authorId === user.id;
    case "token.manage_own":
      return resource.kind === "token" && resource.ownerId === user.id;
  }
}
