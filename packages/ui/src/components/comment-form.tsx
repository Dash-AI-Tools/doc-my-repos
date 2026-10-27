"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  cleanComment,
  commentLength,
  MAX_COMMENT_LENGTH,
} from "@docmyrepos/core/internal/comments";
import { fieldClass } from "@docmyrepos/core/internal/ui";

/**
 * The form used to start a thread, reply and edit (document-comments task 4.2). The label is
 * visible (or screen-reader only for replies and edits, where the button names the target). A
 * validation message or a failed request keeps what was typed. `onSubmit` returns an error
 * message, or null on success.
 */
export interface CommentFormProps {
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly submitLabel: string;
  readonly initialText?: string;
  readonly showOrg?: boolean;
  readonly autoFocus?: boolean;
  readonly clearOnSuccess?: boolean;
  readonly onSubmit: (text: string, asOrganization: boolean) => Promise<string | null>;
  readonly onCancel?: () => void;
}

const PRIMARY =
  "inline-flex min-h-10 w-fit items-center bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50";
const LINK_BUTTON =
  "inline-flex min-h-8 items-center px-1 text-sm underline underline-offset-4 decoration-border hover:decoration-foreground disabled:opacity-50";

export function validationMessage(text: string): string | null {
  const cleaned = cleanComment(text);
  if (cleaned.ok) return null;
  if (cleaned.reason === "empty") return "Write something before posting.";
  return `A comment can have at most ${MAX_COMMENT_LENGTH.toLocaleString("en-GB")} characters; this one has ${commentLength(text).toLocaleString("en-GB")}.`;
}

export function CommentForm({
  label,
  hideLabel = false,
  submitLabel,
  initialText = "",
  showOrg = false,
  autoFocus = false,
  clearOnSuccess = false,
  onSubmit,
  onCancel,
}: CommentFormProps) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [asOrg, setAsOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const length = commentLength(text);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const invalid = validationMessage(text);
    if (invalid !== null) {
      setError(invalid);
      ref.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const failed = await onSubmit(text, showOrg && asOrg);
    setBusy(false);
    if (failed !== null) {
      setError(failed);
      return;
    }
    if (clearOnSuccess) {
      setText("");
      setAsOrg(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <label htmlFor={`${id}-text`} className={hideLabel ? "sr-only" : "text-sm font-medium"}>
        {label}
      </label>
      <textarea
        ref={ref}
        id={`${id}-text`}
        value={text}
        rows={4}
        onChange={(event) => setText(event.target.value)}
        aria-invalid={error !== null}
        aria-describedby={`${id}-count${error !== null ? ` ${id}-error` : ""}`}
        className={`${fieldClass} min-h-24 resize-y border border-input px-2 [overflow-wrap:anywhere]`}
      />
      <p
        id={`${id}-count`}
        className={`text-sm ${length > MAX_COMMENT_LENGTH ? "text-destructive" : "text-muted-foreground"}`}
      >
        {length.toLocaleString("en-GB")} of {MAX_COMMENT_LENGTH.toLocaleString("en-GB")} characters
        {length > MAX_COMMENT_LENGTH
          ? `, ${(length - MAX_COMMENT_LENGTH).toLocaleString("en-GB")} over the limit`
          : ""}
      </p>
      {error !== null ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {showOrg ? (
        <label className="flex min-h-8 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={asOrg}
            onChange={(event) => setAsOrg(event.target.checked)}
            className="size-4 shrink-0"
          />
          Comment as the organization
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? "Saving..." : submitLabel}
        </button>
        {onCancel !== undefined ? (
          <button type="button" onClick={onCancel} disabled={busy} className={LINK_BUTTON}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

export { LINK_BUTTON as COMMENT_LINK_BUTTON };
