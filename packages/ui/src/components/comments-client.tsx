"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  applyChange,
  parseChange,
  parsePage,
  type CommentChangeData,
  type CommentsViewer,
  type ThreadData,
} from "@docmyrepos/core/internal/comments-view";
import { formatAbsoluteTime } from "@docmyrepos/core/internal/time";

import { CommentForm, COMMENT_LINK_BUTTON } from "./comment-form";
import { CommentItem, authorName, type ActiveForm, type CommentActions } from "./comment-item";

/**
 * The interactive part of the Comments section (document-comments task 4.2). The first render
 * (the server's, and the client's before hydration) has no actions and no form, so the page reads
 * without script; once mounted it adds the composer, reply, edit, delete, resolve and "Show more".
 * A write updates local state from the API response, announces the result in a polite status
 * region, moves focus to the new or changed comment, then calls `router.refresh()` so the server's
 * view (the count in the header) stays truthful. It does not poll.
 */

export interface CommentsClientProps {
  /** `owner/name`. */
  readonly repo: string;
  /** The stored document path. */
  readonly path: string;
  readonly initialThreads: readonly ThreadData[];
  readonly initialCursor: string | null;
  readonly viewer: CommentsViewer;
  readonly orgName: string;
  /** The server's load time, so relative times match between server and client. */
  readonly loadedAt: string;
}

interface Reply {
  readonly ok: boolean;
  readonly status: number;
  readonly json: unknown;
  readonly retryAfter: number | null;
}

async function call(method: string, url: string, body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // not JSON
    }
    const retry =
      typeof json === "object" && json !== null && "retryAfterSeconds" in json
        ? Number((json as { retryAfterSeconds: unknown }).retryAfterSeconds)
        : NaN;
    return {
      ok: response.ok,
      status: response.status,
      json,
      retryAfter: Number.isFinite(retry) ? retry : null,
    };
  } catch {
    return { ok: false, status: 0, json: null, retryAfter: null };
  }
}

function wait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/** A fixed, readable message for a failed request. */
export function failureMessage(reply: Reply): string {
  if (reply.status === 0) return "Could not reach the server. Check your connection and try again.";
  if (reply.status === 429) {
    return reply.retryAfter === null
      ? "You are posting too fast. Try again in a few minutes."
      : `You are posting too fast. Try again in ${wait(reply.retryAfter)}.`;
  }
  if (reply.status === 401) return "Your session has ended. Sign in again to comment.";
  if (reply.status === 403) return "You are not allowed to do that.";
  if (reply.status === 404) return "This comment or document is no longer available.";
  if (reply.status === 409) return "This document has reached the limit of 1,000 comments.";
  const error =
    typeof reply.json === "object" && reply.json !== null && "error" in reply.json
      ? (reply.json as { error: unknown }).error
      : null;
  return typeof error === "string" && error !== "" && reply.status === 400
    ? error
    : "Something went wrong. Try again.";
}

/** `false` on the server and while hydrating, `true` afterwards: no actions without script. */
const subscribeNever = () => () => {};

const HEADING_ID = "comments-heading";
const GENERIC = "Something went wrong. Try again.";

export function CommentsClient({
  repo,
  path,
  initialThreads,
  initialCursor,
  viewer,
  orgName,
  loadedAt,
}: CommentsClientProps) {
  const router = useRouter();
  const ready = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const [threads, setThreads] = useState<readonly ThreadData[]>(initialThreads);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [active, setActive] = useState<ActiveForm | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date(loadedAt));
  const focusId = useRef<string | null>(null);

  // Move focus once the new state is in the DOM.
  useEffect(() => {
    const id = focusId.current;
    if (id === null) return;
    focusId.current = null;
    document.getElementById(id)?.focus();
  }, [threads, active]);

  const announce = useCallback((text: string) => {
    // The same text twice in a row must still be announced.
    setStatus((previous) => (previous === text ? `${text}​` : text));
  }, []);

  /** Applies a successful change: state, focus, announcement, server refresh. */
  const applied = useCallback(
    (change: CommentChangeData, commentId: number, focus: string, done: string) => {
      focusId.current = change.removed ? HEADING_ID : focus;
      setThreads((current) => applyChange(current, change, commentId));
      setActive(null);
      setNow(new Date());
      announce(done);
      router.refresh();
    },
    [announce, router],
  );

  const fail = useCallback(
    (reply: Reply): string => {
      const message = reply.ok ? GENERIC : failureMessage(reply);
      announce(message);
      return message;
    },
    [announce],
  );

  const mutate = useCallback(
    async (
      method: "PATCH" | "DELETE",
      id: number,
      body: unknown,
      done: string,
    ): Promise<string | null> => {
      setBusy(true);
      const reply = await call(method, `/api/comments/${id}`, body);
      setBusy(false);
      const change = reply.ok ? parseChange(reply.json) : null;
      if (change === null) return fail(reply);
      applied(change, id, `comment-${id}`, done);
      return null;
    },
    [applied, fail],
  );

  const create = useCallback(
    async (
      text: string,
      asOrg: boolean,
      parentId: number | null,
      done: string,
    ): Promise<string | null> => {
      const reply = await call("POST", "/api/comments", {
        repo,
        path,
        body: text,
        ...(parentId === null ? {} : { parentId }),
        ...(asOrg ? { asOrganization: true } : {}),
      });
      const change = reply.ok ? parseChange(reply.json) : null;
      if (change === null || change.comment === null) return fail(reply);
      applied(change, change.comment.id, `comment-${change.comment.id}`, done);
      return null;
    },
    [applied, fail, repo, path],
  );

  const actions: CommentActions = {
    onOpen: setActive,
    onClose: (id) => {
      focusId.current = `comment-${id}`;
      setActive(null);
    },
    onReply: (id, text, asOrg) => create(text, asOrg, id, "Reply posted."),
    onEdit: (id, text) => mutate("PATCH", id, { body: text }, "Comment updated."),
    onDelete: async (id) => {
      await mutate("DELETE", id, undefined, "Comment deleted.");
    },
    onResolve: async (rootId, resolved) => {
      await mutate(
        "PATCH",
        rootId,
        { resolved },
        resolved ? "Thread resolved." : "Thread reopened.",
      );
    },
  };

  async function showMore() {
    if (cursor === null || busy) return;
    setBusy(true);
    setMoreError(null);
    const params = new URLSearchParams({ repo, path, cursor });
    const reply = await call("GET", `/api/comments?${params.toString()}`);
    setBusy(false);
    const page = reply.ok ? parsePage(reply.json) : null;
    if (page === null) {
      setMoreError(fail(reply));
      return;
    }
    const known = new Set(threads.map((t) => t.root.id));
    const fresh = page.threads.filter((t) => !known.has(t.root.id));
    const first = fresh[0];
    if (first !== undefined) focusId.current = `comment-${first.root.id}`;
    setThreads((current) => [...current, ...fresh]);
    setCursor(page.nextCursor);
    setNow(new Date());
    announce(fresh.length === 1 ? "Loaded 1 more thread." : `Loaded ${fresh.length} more threads.`);
  }

  const interactive = ready ? actions : null;

  return (
    <div className="flex flex-col gap-8">
      <p role="status" aria-live="polite" data-testid="comments-status" className="sr-only">
        {status}
      </p>

      {threads.length === 0 ? (
        <p data-testid="comments-empty" className="text-muted-foreground">
          No comments yet.
        </p>
      ) : (
        <ol className="flex flex-col" data-testid="comment-threads">
          {threads.map((thread) => (
            <li key={thread.root.id} className="border-t border-border py-5 first:border-t-0">
              <Thread
                thread={thread}
                viewer={viewer}
                orgName={orgName}
                now={now}
                actions={interactive}
                active={active}
                busy={busy}
              />
            </li>
          ))}
        </ol>
      )}

      {cursor !== null && ready ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void showMore()}
            disabled={busy}
            className={`${COMMENT_LINK_BUTTON} w-fit`}
          >
            Show more comments
          </button>
          {moreError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {moreError}
            </p>
          ) : null}
        </div>
      ) : null}
      {cursor !== null && !ready ? (
        <p className="text-sm text-muted-foreground">More comments need script to load.</p>
      ) : null}

      {ready ? (
        <div className="border-t border-border pt-5">
          <CommentForm
            label="Add a comment"
            submitLabel="Post comment"
            showOrg={viewer.isAdmin}
            clearOnSuccess
            onSubmit={(text, asOrg) => create(text, asOrg, null, "Comment posted.")}
          />
        </div>
      ) : (
        <noscript>
          <p className="border-t border-border pt-5 text-muted-foreground">
            Posting, replying and editing comments needs JavaScript. The existing comments above are
            readable without it.
          </p>
        </noscript>
      )}
    </div>
  );
}

function Thread({
  thread,
  viewer,
  orgName,
  now,
  actions,
  active,
  busy,
}: {
  readonly thread: ThreadData;
  readonly viewer: CommentsViewer;
  readonly orgName: string;
  readonly now: Date;
  readonly actions: CommentActions | null;
  readonly active: ActiveForm | null;
  readonly busy: boolean;
}) {
  const { root, replies } = thread;
  const body = (
    <div className="flex flex-col gap-4">
      <CommentItem
        comment={root}
        viewer={viewer}
        orgName={orgName}
        now={now}
        isRoot
        hasReplies={replies.length > 0}
        actions={actions}
        active={active}
        busy={busy}
      />
      {replies.length > 0 ? (
        <ol className="ml-4 flex flex-col gap-4 border-l border-border pl-4 sm:ml-6">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentItem
                comment={reply}
                viewer={viewer}
                orgName={orgName}
                now={now}
                isRoot={false}
                hasReplies={false}
                actions={actions}
                active={active}
                busy={busy}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
  if (root.resolvedAt === null) return body;
  const replyText = replies.length === 1 ? "1 reply" : `${replies.length} replies`;
  return (
    <details data-testid="resolved-thread">
      <summary
        id={`thread-${root.id}`}
        className="min-h-8 cursor-pointer text-sm [overflow-wrap:anywhere]"
      >
        <span className="font-bold">Resolved</span> thread started by{" "}
        {root.deleted ? "a deleted comment" : authorName(root, orgName)}, {replyText}
        <span className="sr-only">
          , resolved {formatAbsoluteTime(new Date(root.resolvedAt))}. Expand to read it.
        </span>
      </summary>
      <div className="mt-4">{body}</div>
    </details>
  );
}
