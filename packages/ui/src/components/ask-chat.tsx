"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { sanitizeAnswer } from "@docmyrepos/core/internal/ask/answer";
import {
  INITIAL_CHAT,
  MAX_QUESTION_CHARS,
  chatReducer,
  historyFor,
  isActive,
  noticeFor,
  type ChatMessage,
} from "@docmyrepos/core/internal/ask/chat-state";
import {
  carriedConversation,
  carryConversation,
  clearCarriedConversation,
} from "@docmyrepos/core/internal/ask/carry";
import type { AskReference } from "@docmyrepos/core/internal/ask/events";
import { messageForHttp } from "@docmyrepos/core/internal/ask/messages";
import { readAskEvents } from "@docmyrepos/core/internal/ask/stream-client";
import { fieldClass } from "@docmyrepos/core/internal/ui";

import { AskAnswer } from "./ask-answer";

/** What the server page hands the island. Everything here was built from stored data. */
export interface AskChatProps {
  /** "Anthropic", or "OpenAI-compatible endpoint". */
  readonly providerLabel: string;
  /** Host name of an OpenAI-compatible endpoint, shown so people know where data goes. */
  readonly host: string | null;
  /** The repository the question is limited to, as `owner/name`, or null. */
  readonly scope: string | null;
  /** Repositories the reader can pick as a scope (`owner/name`). */
  readonly repos: readonly string[];
  /** A question to put in the field (from search), not sent. */
  readonly initialQuestion: string;
  /** "page" fills the page container; "panel" fills the floating panel and adds its toolbar. */
  readonly variant?: "page" | "panel";
  /** Closes the floating panel (panel variant). */
  readonly onClose?: () => void;
}

const COUNTER_FROM = 1800;

/** Only same-site paths become links, whatever the server sent. */
function safeHref(href: string | null): string | null {
  return href !== null && href.startsWith("/") && !href.startsWith("//") ? href : null;
}

function referenceText(ref: AskReference): string {
  return ref.heading
    ? `${ref.title}, section ${ref.heading} (${ref.repo}/${ref.path})`
    : `${ref.title} (${ref.repo}/${ref.path})`;
}

function References({
  refs,
  idPrefix,
}: {
  readonly refs: readonly AskReference[];
  readonly idPrefix: string;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <h2 className="text-sm font-bold">References</h2>
      <ul className="mt-1 flex flex-col gap-1 text-sm">
        {refs.map((ref) => {
          const href = safeHref(ref.href);
          return (
            <li
              key={ref.n}
              id={`${idPrefix}-ref-${ref.n}`}
              className="break-words [overflow-wrap:anywhere]"
            >
              <span className="text-muted-foreground">[{ref.n}] </span>
              {href ? (
                <Link
                  href={href}
                  className="inline-block min-h-6 py-0.5 underline underline-offset-2"
                >
                  {referenceText(ref)}
                </Link>
              ) : (
                referenceText(ref)
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Exchange({ message }: { readonly message: ChatMessage }) {
  const idPrefix = `ask-${message.id}`;
  const valid = useMemo(() => new Set(message.references.map((r) => r.n)), [message.references]);
  const blocks = useMemo(() => sanitizeAnswer(message.answer, valid), [message.answer, valid]);
  const notice = noticeFor(message);
  const pending = isActive(message);
  return (
    <article
      aria-label={`Question: ${message.question.slice(0, 80)}`}
      data-testid="ask-exchange"
      data-status={message.status}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <p className="font-medium break-words [overflow-wrap:anywhere]">
        <span className="sr-only">You asked: </span>
        {message.question}
      </p>
      {message.answer !== "" ? (
        <div data-testid="ask-answer">
          <AskAnswer blocks={blocks} idPrefix={idPrefix} />
        </div>
      ) : null}
      {pending ? (
        <p className="text-sm text-muted-foreground" data-testid="ask-progress">
          {message.status === "searching"
            ? "Searching the documentation…"
            : message.answer === ""
              ? "Writing the answer…"
              : null}
        </p>
      ) : null}
      {notice ? (
        <p
          data-testid="ask-notice"
          className={
            message.status === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {notice}
        </p>
      ) : null}
      {message.status === "no_results" && message.references.length === 0 ? (
        <p className="text-sm">
          <Link
            href={`/search?q=${encodeURIComponent(message.question.slice(0, 200))}`}
            className="underline underline-offset-2"
          >
            Search the documentation for this question
          </Link>
        </p>
      ) : null}
      <References refs={message.references} idPrefix={idPrefix} />
    </article>
  );
}

/**
 * The Ask chat island (ask-the-docs design decision 10). State lives in memory only: reloading the
 * page starts an empty conversation, and nothing is written to storage. The answer arrives as
 * server-sent events and is shown through the safe renderer; references are links built by the
 * server. Enter sends, Shift+Enter adds a line; Stop keeps the text received.
 */
export function AskChat({
  providerLabel,
  host,
  scope,
  repos,
  initialQuestion,
  variant = "page",
  onClose,
}: AskChatProps) {
  const [chat, dispatch] = useReducer(chatReducer, INITIAL_CHAT, () => {
    if (variant !== "page") return INITIAL_CHAT;
    return carriedConversation() ?? INITIAL_CHAT;
  });
  // The carried conversation was taken on first render; it is not offered again.
  useEffect(() => clearCarriedConversation(), []);
  const nextMessageId = Math.max(0, ...chat.messages.map((m) => m.id)) + 1;
  const [text, setText] = useState(initialQuestion);
  const [repo, setRepo] = useState<string | null>(scope);
  const [changing, setChanging] = useState(false);
  const nextId = useRef(nextMessageId);
  const abortRef = useRef<AbortController | null>(null);
  const chatRef = useRef(chat);
  // The history sent with a question is read from here, so `ask` never closes over stale state.
  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);
  const endRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();

  const busy = chat.messages.some(isActive);
  const last = chat.messages.at(-1);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Bring the newest exchange into view without moving focus.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [chat.messages.length, last?.answer]);

  const ask = useCallback(
    async (question: string): Promise<void> => {
      const id = nextId.current++;
      const history = historyFor(chatRef.current.messages);
      dispatch({ type: "start", id, question });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history, ...(repo ? { repo } : {}) }),
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          dispatch({ type: "fail", id, message: messageForHttp(response.status, data) });
          return;
        }
        let finished = false;
        for await (const event of readAskEvents(response.body)) {
          dispatch({ type: "event", id, event });
          if (event.event === "done" || event.event === "error") finished = true;
        }
        // A stream that ends without `done` or `error` was cut off on the way.
        if (!finished)
          dispatch({ type: "event", id, event: { event: "error", data: { kind: "malformed" } } });
      } catch {
        if (controller.signal.aborted) dispatch({ type: "stop", id });
        else
          dispatch({ type: "event", id, event: { event: "error", data: { kind: "unavailable" } } });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [repo],
  );

  function submit(): void {
    const question = text.trim();
    if (question === "" || busy) return;
    setText("");
    void ask(question);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  function retry(message: ChatMessage): void {
    dispatch({ type: "remove", id: message.id });
    void ask(message.question);
  }

  function newConversation(): void {
    abortRef.current?.abort();
    dispatch({ type: "reset" });
    setText("");
  }

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col gap-3 ${variant === "page" ? "" : "p-3"}`}
      data-variant={variant}
    >
      {variant === "panel" ? (
        <div className="flex shrink-0 items-center justify-between gap-2">
          <h2 className="font-bold">Ask the docs</h2>
          <div className="flex items-center gap-1">
            <Link
              href={repo ? `/ask?repo=${encodeURIComponent(repo)}` : "/ask"}
              onClick={() => carryConversation(chat)}
              aria-label="Open Ask as a full page"
              data-testid="ask-expand"
              className="inline-flex h-8 min-w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <span aria-hidden="true">⤢</span>
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Ask"
              data-testid="ask-close"
              className="inline-flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-md hover:bg-muted"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        </div>
      ) : null}
      <noscript>
        <p className="rounded-md border border-border p-3">
          Ask needs JavaScript. Turn it on in your browser to ask questions, or use search instead.
        </p>
      </noscript>

      <p data-testid="ask-notice-provider" className="shrink-0 text-sm text-muted-foreground">
        Your question, the recent conversation and excerpts from documents you can read are sent to{" "}
        <strong>{providerLabel}</strong>
        {host ? ` (${host})` : ""} to write the answer. The portal does not store them. Answers can
        be wrong: check the references.
      </p>

      <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm" data-testid="ask-scope">
        {repo ? (
          <>
            <span className="rounded-full border border-border px-3 py-1">
              Searching in <strong>{repo}</strong>
            </span>
            <button
              type="button"
              onClick={() => setChanging((v) => !v)}
              className="min-h-6 cursor-pointer underline underline-offset-2"
            >
              Change
            </button>
            <button
              type="button"
              onClick={() => {
                setRepo(null);
                setChanging(false);
              }}
              className="min-h-6 cursor-pointer underline underline-offset-2"
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Searching in all repositories</span>
            {repos.length > 0 ? (
              <button
                type="button"
                onClick={() => setChanging((v) => !v)}
                className="min-h-6 cursor-pointer underline underline-offset-2"
              >
                Limit to a repository
              </button>
            ) : null}
          </>
        )}
        {changing ? (
          <>
            <label htmlFor={`${fieldId}-scope`} className="sr-only">
              Repository to search in
            </label>
            <select
              id={`${fieldId}-scope`}
              value={repo ?? ""}
              onChange={(e) => {
                setRepo(e.target.value === "" ? null : e.target.value);
                setChanging(false);
              }}
              className={`${fieldClass} max-w-full sm:w-auto`}
            >
              <option value="">All repositories</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <section
        role="log"
        aria-live="off"
        aria-label="Conversation"
        data-testid="ask-log"
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {chat.messages.length === 0 ? (
          <p className="text-muted-foreground">
            Ask a question about the documentation. For example: how do I deploy this service?
          </p>
        ) : null}
        {chat.messages.map((message) => (
          <div key={message.id} className="flex min-w-0 flex-col gap-2">
            <Exchange message={message} />
            {message.status === "error" ? (
              <button
                type="button"
                onClick={() => retry(message)}
                disabled={busy}
                className="min-h-6 w-fit cursor-pointer rounded-md border border-input px-3 py-1.5 text-sm hover:border-foreground disabled:opacity-50"
              >
                Try again
              </button>
            ) : null}
          </div>
        ))}
        <div ref={endRef} />
      </section>

      <p role="status" data-testid="ask-live" className="sr-only">
        {chat.announcement}
      </p>

      <form onSubmit={onSubmit} className="flex shrink-0 flex-col gap-2">
        <label htmlFor={`${fieldId}-question`} className="text-sm font-medium">
          Your question
        </label>
        <textarea
          id={`${fieldId}-question`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={MAX_QUESTION_CHARS}
          rows={variant === "panel" ? 2 : 3}
          aria-describedby={`${fieldId}-hint`}
          className="w-full resize-y rounded-md border border-input bg-transparent p-2 text-base hover:border-foreground"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={`${fieldId}-hint`} className="text-sm text-muted-foreground">
            Enter sends, Shift+Enter adds a line.
            {text.length >= COUNTER_FROM ? (
              <span data-testid="ask-counter" className="ml-2">
                {text.length} / {MAX_QUESTION_CHARS}
              </span>
            ) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {busy ? (
              <button
                type="button"
                onClick={stop}
                className="min-h-6 cursor-pointer rounded-md border border-input px-4 py-2 hover:border-foreground"
              >
                Stop
              </button>
            ) : null}
            <button
              type="submit"
              disabled={busy || text.trim() === ""}
              className="min-h-6 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
            >
              Ask
            </button>
          </div>
        </div>
      </form>

      {chat.messages.length > 0 ? (
        <button
          type="button"
          onClick={newConversation}
          className="min-h-6 w-fit shrink-0 cursor-pointer text-sm underline underline-offset-2"
        >
          New conversation
        </button>
      ) : null}
    </div>
  );
}
