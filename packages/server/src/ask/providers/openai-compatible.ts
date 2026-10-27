import type { Secret } from "../../config/secret";
import { parseSse } from "./sse";
import {
  ProviderError,
  RequestGuard,
  count,
  isRecord,
  limitOutput,
  outputCharLimit,
  readJson,
  send,
  type PreparedRequest,
} from "./shared";
import type {
  CompleteOptions,
  CompleteResult,
  ProviderAdapter,
  ProviderDeps,
  ProviderEvent,
  ProviderMessage,
} from "./types";

/** `<base>/chat/completions`, keeping the base path (`/v1`) and dropping any query or fragment. */
export function chatCompletionsUrl(baseUrl: URL): URL {
  const url = new URL(baseUrl.href);
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.pathname += "chat/completions";
  return url;
}

function buildRequest(
  baseUrl: URL,
  apiKey: Secret<string> | null,
  model: string,
  messages: readonly ProviderMessage[],
  options: CompleteOptions,
  stream: boolean,
): PreparedRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey.reveal()}`;
  const body = {
    model,
    max_tokens: options.maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  return { url: chatCompletionsUrl(baseUrl), headers, body: JSON.stringify(body) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError("malformed");
  }
}

function usageOf(value: unknown): { input: number | null; output: number | null } {
  if (!isRecord(value)) return { input: null, output: null };
  return { input: count(value.prompt_tokens), output: count(value.completion_tokens) };
}

async function* events(response: Response, guard: RequestGuard): AsyncGenerator<ProviderEvent> {
  if (!response.body) throw new ProviderError("malformed");
  let finish: string | null = null;
  let done = false;
  let usage: { input: number | null; output: number | null } | null = null;

  try {
    for await (const message of parseSse(response.body)) {
      if (message.data === "[DONE]") {
        done = true;
        break;
      }
      const data = parseJson(message.data);
      if (!isRecord(data)) throw new ProviderError("malformed");
      if (isRecord(data.error)) throw new ProviderError("unavailable");
      if (data.usage) usage = usageOf(data.usage);
      const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
      if (!isRecord(choice)) continue; // the final usage-only chunk has no choices
      if (isRecord(choice.delta) && typeof choice.delta.content === "string") {
        if (choice.delta.content !== "") yield { type: "text", text: choice.delta.content };
      }
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    }
  } catch (error) {
    throw guard.classify(error);
  }

  // Some servers omit `[DONE]`; a finish reason is proof enough that the answer is complete.
  if (!done && finish === null) throw new ProviderError("malformed");
  if (usage && (usage.input !== null || usage.output !== null)) {
    yield { type: "usage", inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0 };
  }
  if (finish === "content_filter") throw new ProviderError("filtered");
  if (finish === "length") yield { type: "cut_off" };
}

export function createOpenAiCompatibleAdapter(
  baseUrl: URL,
  apiKey: Secret<string> | null,
  model: string,
  deps: ProviderDeps = {},
): ProviderAdapter {
  return {
    provider: "openai-compatible",

    async *stream(messages, options) {
      const guard = new RequestGuard(options);
      try {
        const response = await send(
          buildRequest(baseUrl, apiKey, model, messages, options, true),
          guard,
          deps,
        );
        yield* limitOutput(events(response, guard), outputCharLimit(options));
      } catch (error) {
        throw guard.classify(error);
      } finally {
        guard.dispose();
      }
    },

    async completeOnce(messages, options): Promise<CompleteResult> {
      const guard = new RequestGuard(options);
      try {
        const response = await send(
          buildRequest(baseUrl, apiKey, model, messages, options, false),
          guard,
          deps,
        );
        const data = await readJson(response, guard);
        const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
        if (!isRecord(choice) || !isRecord(choice.message)) throw new ProviderError("malformed");
        if (choice.finish_reason === "content_filter") throw new ProviderError("filtered");
        const content = choice.message.content;
        if (typeof content !== "string") throw new ProviderError("malformed");
        const usage = usageOf(isRecord(data) ? data.usage : undefined);
        return {
          text: content,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cutOff: choice.finish_reason === "length",
        };
      } catch (error) {
        throw guard.classify(error);
      } finally {
        guard.dispose();
      }
    },
  };
}
