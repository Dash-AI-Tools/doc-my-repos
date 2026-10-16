import type { AskEvent, AskReference } from "./events";
import { ASK_CUT_OFF_NOTICE, ASK_ERROR_MESSAGES, ASK_NO_RESULTS } from "./messages";

/**
 * State of one Ask conversation, kept in memory only (ask-the-docs "Conversation and follow-ups").
 * Pure reducer, so the whole behaviour is testable without a browser. Nothing here is persisted.
 */

export const MAX_QUESTION_CHARS = 2000;
export const MAX_HISTORY = 4;
/** The server accepts at most this many characters of an earlier answer. */
export const MAX_HISTORY_ANSWER_CHARS = 8000;

export type MessageStatus =
  "searching" | "answering" | "done" | "cut_off" | "no_results" | "stopped" | "error";

export interface ChatMessage {
  readonly id: number;
  readonly question: string;
  /** The raw text received so far; rendered only through `sanitizeAnswer`. */
  readonly answer: string;
  readonly references: readonly AskReference[];
  readonly status: MessageStatus;
  /** A fixed message for an `error` status. */
  readonly errorMessage: string | null;
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  /** Spoken by a polite status region: an answer is ready, stopped, failed. Never answer text. */
  readonly announcement: string;
}

export const INITIAL_CHAT: ChatState = { messages: [], announcement: "" };

export type ChatAction =
  | { readonly type: "start"; readonly id: number; readonly question: string }
  | { readonly type: "event"; readonly id: number; readonly event: AskEvent }
  | { readonly type: "stop"; readonly id: number }
  | { readonly type: "fail"; readonly id: number; readonly message: string }
  | { readonly type: "remove"; readonly id: number }
  | { readonly type: "reset" };

const ACTIVE: ReadonlySet<MessageStatus> = new Set(["searching", "answering"]);

export const isActive = (message: ChatMessage): boolean => ACTIVE.has(message.status);

function update(
  state: ChatState,
  id: number,
  change: (m: ChatMessage) => Partial<ChatMessage>,
  announcement?: string,
): ChatState {
  return {
    messages: state.messages.map((m) => (m.id === id ? { ...m, ...change(m) } : m)),
    announcement: announcement ?? state.announcement,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "start":
      return {
        messages: [
          ...state.messages,
          {
            id: action.id,
            question: action.question,
            answer: "",
            references: [],
            status: "searching",
            errorMessage: null,
          },
        ],
        announcement: "",
      };
    case "event": {
      const { event } = action;
      switch (event.event) {
        case "status":
          return update(state, action.id, () => ({ status: event.data.state }));
        case "references":
          return update(state, action.id, () => ({ references: event.data.references }));
        case "delta":
          return update(state, action.id, (m) => ({
            answer: m.answer + event.data.text,
            status: "answering",
          }));
        case "done":
          return update(
            state,
            action.id,
            () => ({ status: event.data.outcome === "ok" ? "done" : event.data.outcome }),
            event.data.outcome === "no_results" ? ASK_NO_RESULTS : "Answer ready.",
          );
        case "error": {
          const message = ASK_ERROR_MESSAGES[event.data.kind] ?? ASK_ERROR_MESSAGES.unavailable;
          return update(
            state,
            action.id,
            () => ({ status: "error", errorMessage: message }),
            message,
          );
        }
      }
      return state;
    }
    case "stop":
      return update(
        state,
        action.id,
        (m) => (isActive(m) ? { status: "stopped" } : {}),
        "Stopped.",
      );
    case "fail":
      return update(
        state,
        action.id,
        (m) => (isActive(m) ? { status: "error", errorMessage: action.message } : {}),
        action.message,
      );
    case "remove":
      return { messages: state.messages.filter((m) => m.id !== action.id), announcement: "" };
    case "reset":
      return INITIAL_CHAT;
  }
}

/**
 * The earlier exchanges to send with a new question: the last `MAX_HISTORY` that have an answer
 * text (a stopped answer counts, with what was received), lengths capped to what the server takes.
 */
export function historyFor(
  messages: readonly ChatMessage[],
): { question: string; answer: string }[] {
  return messages
    .filter((m) => m.answer.trim() !== "")
    .slice(-MAX_HISTORY)
    .map((m) => ({
      question: m.question.slice(0, MAX_QUESTION_CHARS),
      answer: m.answer.slice(0, MAX_HISTORY_ANSWER_CHARS),
    }));
}

/** A note to show under a finished message, or null. */
export function noticeFor(message: ChatMessage): string | null {
  if (message.status === "cut_off") return ASK_CUT_OFF_NOTICE;
  if (message.status === "no_results") return ASK_NO_RESULTS;
  if (message.status === "stopped") return "You stopped this answer.";
  if (message.status === "error") return message.errorMessage;
  return null;
}
