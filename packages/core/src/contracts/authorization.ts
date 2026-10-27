/**
 * Every permission check the core makes is one of these actions, decided by the `authorize` hook.
 * Repository visibility is not an action: it stays with the shared visibility filter.
 */
export const ACTIONS = [
  "admin.manage",
  "content.read",
  "ask.use",
  "comment.create",
  "comment.create_as_organization",
  "comment.edit",
  "comment.delete",
  "comment.resolve",
  "comment.moderate",
  "comment.view_author_email",
  "token.manage_own",
  "token.manage_any",
] as const;

export type Action = (typeof ACTIONS)[number];

/** What an action applies to. */
export type Resource =
  | { readonly kind: "workspace" }
  | { readonly kind: "document"; readonly githubRepoId: number; readonly path: string }
  | {
      readonly kind: "comment";
      readonly authorId: number | null;
      readonly asOrganization: boolean;
    }
  | { readonly kind: "token"; readonly ownerId: number };

export const WORKSPACE: Resource = Object.freeze({ kind: "workspace" });

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}
