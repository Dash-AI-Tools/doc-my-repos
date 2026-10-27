"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  commentCount,
  moderationHref,
  type ModerationFilters,
} from "@docmyrepos/core/internal/comments-moderation";

/**
 * The buttons of one moderation row (document-comments task 5.1): delete a comment, or
 * permanently remove stored comments after a confirmation that states how many go. Without script
 * the row simply has no buttons. After a success the page is reloaded at the page address with a notice, whose
 * notice shows the count removed.
 */

export type ModerationAction =
  | { readonly kind: "delete"; readonly id: number }
  | { readonly kind: "purge-ids"; readonly ids: readonly number[] }
  | { readonly kind: "purge-document"; readonly githubRepoId: number; readonly path: string };

export interface ModerationActionsProps {
  readonly action: ModerationAction;
  readonly buttonLabel: string;
  /** What the confirmation names, e.g. the author or the document. */
  readonly subject: string;
  /** How many comments the action removes (stated in the confirmation). */
  readonly count: number;
  /**
   * The filters of the page, where to go back to after success (plus a notice with the count).
   * Plain data: this component is rendered by a server component, which cannot pass functions.
   */
  readonly filters: ModerationFilters;
}

const rowButton =
  "inline-flex min-h-6 items-center text-sm underline underline-offset-4 decoration-border hover:decoration-foreground disabled:opacity-50";
const dangerButton =
  "min-h-6 bg-foreground px-3 py-1 text-sm font-medium text-background transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50";

async function send(
  action: ModerationAction,
): Promise<{ ok: boolean; removed: number; error: string }> {
  const [method, url, body] =
    action.kind === "delete"
      ? (["DELETE", `/api/admin/comments/${action.id}`, undefined] as const)
      : action.kind === "purge-ids"
        ? (["POST", "/api/admin/comments/purge", { ids: action.ids }] as const)
        : ([
            "POST",
            "/api/admin/comments/purge",
            { githubRepoId: action.githubRepoId, path: action.path },
          ] as const);
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json = null as { removed?: unknown; error?: unknown } | null;
    try {
      json = (await response.json()) as typeof json;
    } catch {
      // not JSON
    }
    if (response.ok) {
      return { ok: true, removed: typeof json?.removed === "number" ? json.removed : 0, error: "" };
    }
    const text = typeof json?.error === "string" ? json.error : "";
    const reason =
      response.status === 409
        ? "It cannot be removed: it is still live or has live replies."
        : response.status === 404
          ? "It no longer exists. Reload the page."
          : response.status === 401 || response.status === 403
            ? "You are not allowed to do this. Sign in again."
            : text || `The request failed (${response.status}).`;
    return { ok: false, removed: 0, error: reason };
  } catch {
    return { ok: false, removed: 0, error: "The request could not be sent. Try again." };
  }
}

export function ModerationActions({
  action,
  buttonLabel,
  subject,
  count,
  filters,
}: ModerationActionsProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

  const isDelete = action.kind === "delete";
  const question = isDelete
    ? `Delete the comment by ${subject}? Its text is removed and this cannot be undone.`
    : `Permanently remove ${commentCount(count)} (${subject})? This cannot be undone.`;

  async function confirm() {
    setBusy(true);
    setError("");
    const result = await send(action);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    router.push(
      moderationHref(filters, {
        removed: isDelete ? null : result.removed,
        deleted: isDelete ? 1 : null,
      }),
    );
    router.refresh();
  }

  function close() {
    setConfirming(false);
    setError("");
    queueMicrotask(() => opener.current?.focus());
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-1">
        <button
          ref={opener}
          type="button"
          className={rowButton}
          aria-label={`${buttonLabel}: ${subject}`}
          onClick={() => setConfirming(true)}
        >
          {buttonLabel}
        </button>
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Confirm: ${buttonLabel}, ${subject}`}
      className="flex min-w-0 flex-col gap-2 border-l-2 border-foreground pl-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) close();
      }}
    >
      <p className="text-sm [overflow-wrap:anywhere]">{question}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={dangerButton} disabled={busy} onClick={confirm}>
          {busy ? "Working…" : isDelete ? "Delete comment" : `Remove ${commentCount(count)}`}
        </button>
        <button ref={cancel} type="button" className={rowButton} disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
      {error === "" ? null : (
        <p
          role="alert"
          className="border border-destructive-muted-border bg-destructive-muted p-2 text-sm text-destructive-muted-foreground"
        >
          {error}
        </p>
      )}
    </div>
  );
}
