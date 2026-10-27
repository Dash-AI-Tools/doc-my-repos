"use client";

import { useEffect, useRef } from "react";

import type { CommentData, CommentsViewer } from "@docmyrepos/core/internal/comments-view";
import { formatAbsoluteTime, formatRelativeTime } from "@docmyrepos/core/internal/time";

import { CommentForm, COMMENT_LINK_BUTTON } from "./comment-form";
import { CommentText } from "./comment-text";

/**
 * One comment (document-comments tasks 4.1 and 4.2): author, "Organization" badge, time with the
 * exact time available, "edited", the text or the deleted placeholder, and (once the page is
 * interactive) its actions. The text is untrusted and goes through `CommentText`.
 */

export type ActiveForm =
  | { readonly kind: "reply"; readonly id: number }
  | { readonly kind: "edit"; readonly id: number }
  | { readonly kind: "delete"; readonly id: number };

export interface CommentActions {
  readonly onOpen: (form: ActiveForm) => void;
  readonly onClose: (focusId: number) => void;
  readonly onReply: (id: number, text: string, asOrg: boolean) => Promise<string | null>;
  readonly onEdit: (id: number, text: string) => Promise<string | null>;
  readonly onDelete: (id: number) => Promise<void>;
  readonly onResolve: (rootId: number, resolved: boolean) => Promise<void>;
}

export interface CommentItemProps {
  readonly comment: CommentData;
  readonly viewer: CommentsViewer;
  readonly orgName: string;
  readonly now: Date;
  /** True for a thread's first comment. */
  readonly isRoot: boolean;
  /** Whether others reply to this comment: changes the delete confirmation. */
  readonly hasReplies: boolean;
  /** Null until the page is interactive: no actions are drawn. */
  readonly actions: CommentActions | null;
  readonly active: ActiveForm | null;
  readonly busy: boolean;
}

export function authorName(comment: CommentData, orgName: string): string {
  return comment.asOrg ? orgName : comment.authorLabel;
}

function Time({ iso, now }: { readonly iso: string; readonly now: Date }) {
  const date = new Date(iso);
  const exact = formatAbsoluteTime(date);
  return (
    <time dateTime={iso} title={exact}>
      {formatRelativeTime(date, now)}
      <span className="sr-only"> ({exact})</span>
    </time>
  );
}

function DeleteConfirm({
  hasReplies,
  name,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly hasReplies: boolean;
  readonly name: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="group"
      aria-label={`Confirm deleting the comment by ${name}`}
      className="flex flex-col gap-2"
    >
      <p className="text-sm">
        {hasReplies
          ? "Delete this comment? Its text is removed and the replies stay under “This comment was deleted”."
          : "Delete this comment? Its text is removed and this cannot be undone."}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="inline-flex min-h-8 items-center bg-destructive px-3 text-sm font-medium text-destructive-foreground disabled:opacity-50"
        >
          Delete comment
        </button>
        <button ref={cancel} type="button" onClick={onCancel} className={COMMENT_LINK_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function CommentItem({
  comment,
  viewer,
  orgName,
  now,
  isRoot,
  hasReplies,
  actions,
  active,
  busy,
}: CommentItemProps) {
  const name = authorName(comment, orgName);
  // Decided on the server by the `authorize` hook; the page offers exactly what the API accepts.
  const mayEdit = comment.can.edit;
  const mayDelete = comment.can.delete;
  const mayResolve = isRoot && comment.can.resolve;
  const here = active !== null && active.id === comment.id ? active.kind : null;
  const aside = [
    comment.asOrg && viewer.isAdmin ? `posted by ${comment.authorLabel}` : null,
    comment.authorEmail,
  ].filter((part): part is string => part !== null && part !== "");

  return (
    <article
      id={`comment-${comment.id}`}
      tabIndex={-1}
      data-testid="comment"
      aria-label={comment.deleted ? "Deleted comment" : `Comment by ${name}`}
      className="flex min-w-0 flex-col gap-2 outline-offset-4"
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        {comment.deleted ? null : (
          <>
            <span className="font-bold [overflow-wrap:anywhere]">{name}</span>
            {comment.asOrg ? (
              <span className="border border-foreground px-1.5 text-xs font-medium">
                Organization
              </span>
            ) : null}
            {aside.length > 0 ? (
              <span
                data-testid="comment-aside"
                className="text-muted-foreground [overflow-wrap:anywhere]"
              >
                ({aside.join(", ")})
              </span>
            ) : null}
          </>
        )}
        <span className="text-muted-foreground">
          <Time iso={comment.createdAt} now={now} />
        </span>
        {comment.editedAt !== null ? <span className="text-muted-foreground">edited</span> : null}
      </header>

      {comment.deleted ? (
        <p className="text-muted-foreground italic">This comment was deleted</p>
      ) : here === "edit" && actions !== null ? (
        <CommentForm
          label={`Edit the comment by ${name}`}
          hideLabel
          submitLabel="Save changes"
          initialText={comment.body}
          autoFocus
          onSubmit={(text) => actions.onEdit(comment.id, text)}
          onCancel={() => actions.onClose(comment.id)}
        />
      ) : (
        <CommentText body={comment.body} />
      )}

      {actions !== null && !comment.deleted && here !== "edit" ? (
        <div className="flex flex-wrap items-center gap-x-3">
          <button
            type="button"
            className={COMMENT_LINK_BUTTON}
            aria-label={`Reply to the comment by ${name}`}
            aria-expanded={here === "reply"}
            onClick={() => actions.onOpen({ kind: "reply", id: comment.id })}
          >
            Reply
          </button>
          {mayEdit ? (
            <button
              type="button"
              className={COMMENT_LINK_BUTTON}
              aria-label={`Edit the comment by ${name}`}
              onClick={() => actions.onOpen({ kind: "edit", id: comment.id })}
            >
              Edit
            </button>
          ) : null}
          {mayDelete ? (
            <button
              type="button"
              className={COMMENT_LINK_BUTTON}
              aria-label={`Delete the comment by ${name}`}
              onClick={() => actions.onOpen({ kind: "delete", id: comment.id })}
            >
              Delete
            </button>
          ) : null}
          {mayResolve ? (
            <button
              type="button"
              className={COMMENT_LINK_BUTTON}
              disabled={busy}
              aria-label={`${comment.resolvedAt === null ? "Resolve" : "Reopen"} the thread started by ${name}`}
              onClick={() => void actions.onResolve(comment.id, comment.resolvedAt === null)}
            >
              {comment.resolvedAt === null ? "Resolve" : "Reopen"}
            </button>
          ) : null}
        </div>
      ) : null}

      {actions !== null && here === "delete" ? (
        <DeleteConfirm
          hasReplies={hasReplies}
          name={name}
          busy={busy}
          onConfirm={() => void actions.onDelete(comment.id)}
          onCancel={() => actions.onClose(comment.id)}
        />
      ) : null}

      {actions !== null && here === "reply" ? (
        <CommentForm
          label={`Write a reply to the comment by ${name}`}
          hideLabel
          submitLabel="Post reply"
          showOrg={viewer.isAdmin}
          autoFocus
          onSubmit={(text, asOrg) => actions.onReply(comment.id, text, asOrg)}
          onCancel={() => actions.onClose(comment.id)}
        />
      ) : null}
    </article>
  );
}
