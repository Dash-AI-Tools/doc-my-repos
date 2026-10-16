import type { AiProvider } from "../../config/env";

/** One message sent to a model. The system prompt is passed as a `system` message. */
export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** What a provider stream yields. `cut_off` ends the stream: the output limit was reached. */
export type ProviderEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "cut_off" };

export interface CompleteOptions {
  readonly maxTokens: number;
  /** Aborts the request (client disconnect, Stop). Surfaces as a `ProviderError` of kind `aborted`. */
  readonly signal?: AbortSignal;
  /** Total time for the request including the whole stream. Default `DEFAULT_DEADLINE_MS`. */
  readonly deadlineMs?: number;
  /** Cuts the output after this many characters. Default derived from `maxTokens`. */
  readonly maxChars?: number;
}

export interface CompleteResult {
  readonly text: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cutOff: boolean;
}

export interface ProviderAdapter {
  readonly provider: AiProvider;
  /** Streams the answer. Retries once on 429/5xx, and only before any output exists. */
  stream(
    messages: readonly ProviderMessage[],
    options: CompleteOptions,
  ): AsyncIterable<ProviderEvent>;
  /** One non-streaming request (the query call and the admin connection test). */
  completeOnce(
    messages: readonly ProviderMessage[],
    options: CompleteOptions,
  ): Promise<CompleteResult>;
}

/** Test seams for the adapters. Production code passes none. */
export interface ProviderDeps {
  readonly fetch?: typeof fetch;
  /** Waits before the retry. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Source of jitter in [0, 1). */
  readonly random?: () => number;
  /** Where the Anthropic adapter sends requests. Never configurable by an admin or the environment. */
  readonly anthropicEndpoint?: URL;
}
