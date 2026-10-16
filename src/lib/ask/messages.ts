import type { AskErrorKind } from "./events";

/**
 * The only texts the Ask page shows for a failure (ask-the-docs "Provider failures are contained").
 * Fixed strings: nothing from a provider, a URL or a key can reach them.
 */
export const ASK_ERROR_MESSAGES: Readonly<Record<AskErrorKind, string>> = {
  unavailable: "The assistant is not available right now. Try again later.",
  busy: "The assistant is busy right now. Try again in a moment.",
  timeout: "The assistant took too long to answer. Try again.",
  malformed: "The answer was interrupted. Try again.",
  filtered: "The assistant could not answer that question.",
};

export const ASK_CUT_OFF_NOTICE = "The answer was cut short because it reached the length limit.";
export const ASK_NO_RESULTS = "Nothing relevant was found in the documentation for that question.";

/** "5 minutes", "1 hour": the wait before a rate-limited user can ask again. */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The message for a non-200 answer of `POST /api/ask`, from its status and JSON body. */
export function messageForHttp(
  status: number,
  body: { code?: unknown; retryAfterSeconds?: unknown },
): string {
  const wait =
    typeof body.retryAfterSeconds === "number" && Number.isFinite(body.retryAfterSeconds)
      ? body.retryAfterSeconds
      : null;
  if (status === 429 && body.code === "user_busy") {
    return "Wait for your current question to finish before asking another.";
  }
  if (status === 429) {
    return wait === null
      ? "You have reached your question limit. Try again later."
      : `You have reached your question limit. You can ask again in ${formatWait(wait)}.`;
  }
  if (status === 503) return ASK_ERROR_MESSAGES.busy;
  if (status === 401) return "Your session has ended. Sign in again to ask questions.";
  if (status === 404) return "Ask is not available.";
  if (status === 400 || status === 413)
    return "That question could not be sent. Shorten it and try again.";
  return ASK_ERROR_MESSAGES.unavailable;
}
