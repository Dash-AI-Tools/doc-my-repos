import type { CompleteOptions, ProviderDeps, ProviderEvent } from "./types";

/** The only things a provider failure can be reported as. No provider text, URL or key is kept. */
export type ProviderErrorKind =
  | "unavailable"
  | "rejected"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "filtered"
  | "malformed"
  | "aborted";

/** A failure with a fixed kind. The message is the kind: nothing from the provider is carried. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind) {
    super(`provider error: ${kind}`);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

export const DEFAULT_DEADLINE_MS = 60_000;
/** Generous characters per output token, so the character cap only bites on a runaway stream. */
const CHARS_PER_TOKEN_CAP = 8;
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 500;

export function outputCharLimit(options: CompleteOptions): number {
  return options.maxChars ?? options.maxTokens * CHARS_PER_TOKEN_CAP;
}

/** Maps an HTTP status to a kind. Only called for a non-2xx response. */
function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "rejected";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

const retryable = (status: number) => status === 429 || status >= 500;

/**
 * One request's lifetime: an abort controller joined to the caller's signal and the total
 * deadline. `classify` turns whatever was thrown into a `ProviderError`; `dispose` aborts anything
 * still open (and so cancels an unfinished stream) and clears the timer.
 */
export class RequestGuard {
  private readonly controller = new AbortController();
  private timedOut = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly caller: AbortSignal | undefined;
  private readonly onCallerAbort = () => this.controller.abort();

  constructor(options: CompleteOptions) {
    this.caller = options.signal;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    if (this.caller?.aborted) this.controller.abort();
    else this.caller?.addEventListener("abort", this.onCallerAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  classify(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    if (this.timedOut) return new ProviderError("timeout");
    if (this.caller?.aborted) return new ProviderError("aborted");
    return new ProviderError("unavailable");
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener("abort", this.onCallerAbort);
    this.controller.abort();
  }
}

export interface PreparedRequest {
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Sends `request` and returns a 2xx response. A 429 or 5xx is retried once, after a short jittered
 * wait, because no output exists yet. Any other status becomes a `ProviderError`; the body of an
 * error response is cancelled unread, so provider text can never reach a log or a user.
 */
export async function send(
  request: PreparedRequest,
  guard: RequestGuard,
  deps: ProviderDeps,
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: guard.signal,
        redirect: "error",
      });
    } catch (error) {
      throw guard.classify(error);
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    if (attempt === 0 && retryable(response.status)) {
      await sleep(RETRY_BASE_MS + Math.floor(random() * RETRY_JITTER_MS));
      if (guard.signal.aborted) throw guard.classify(new Error("aborted"));
      continue;
    }
    throw new ProviderError(kindForStatus(response.status));
  }
}

/** Parses the JSON body of a non-streaming response; anything else is `malformed`. */
export async function readJson(response: Response, guard: RequestGuard): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (guard.signal.aborted) throw guard.classify(error);
    throw new ProviderError("malformed");
  }
}

/**
 * Stops a stream once it has produced `maxChars` characters: the last text event is shortened to
 * fit, a `cut_off` event follows, and the source is closed (which aborts the upstream request).
 */
export async function* limitOutput(
  events: AsyncIterable<ProviderEvent>,
  maxChars: number,
): AsyncGenerator<ProviderEvent> {
  let sent = 0;
  for await (const event of events) {
    if (event.type !== "text") {
      yield event;
      if (event.type === "cut_off") return;
      continue;
    }
    const room = maxChars - sent;
    if (event.text.length <= room) {
      sent += event.text.length;
      yield event;
      continue;
    }
    if (room > 0) yield { type: "text", text: event.text.slice(0, room) };
    yield { type: "cut_off" };
    return;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
