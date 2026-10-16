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

export const ANTHROPIC_ENDPOINT = new URL("https://api.anthropic.com/v1/messages");
const ANTHROPIC_VERSION = "2023-06-01";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError("malformed");
  }
}

function errorKindFor(type: unknown): ProviderError {
  if (type === "authentication_error" || type === "permission_error") {
    return new ProviderError("rejected");
  }
  if (type === "not_found_error") return new ProviderError("not_found");
  if (type === "rate_limit_error") return new ProviderError("rate_limited");
  return new ProviderError("unavailable");
}

function buildRequest(
  endpoint: URL,
  apiKey: Secret<string>,
  model: string,
  messages: readonly ProviderMessage[],
  options: CompleteOptions,
  stream: boolean,
): PreparedRequest {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const body = {
    model,
    max_tokens: options.maxTokens,
    stream,
    ...(system === "" ? {} : { system }),
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content })),
  };
  return {
    url: endpoint,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey.reveal(),
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  };
}

async function* events(response: Response, guard: RequestGuard): AsyncGenerator<ProviderEvent> {
  if (!response.body) throw new ProviderError("malformed");
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stopReason: string | null = null;
  let stopped = false;

  try {
    for await (const message of parseSse(response.body)) {
      const data = parseJson(message.data);
      if (!isRecord(data)) throw new ProviderError("malformed");
      switch (data.type) {
        case "message_start": {
          const usage = isRecord(data.message) ? data.message.usage : undefined;
          if (isRecord(usage)) inputTokens = count(usage.input_tokens);
          break;
        }
        case "content_block_delta": {
          const delta = data.delta;
          if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
            if (delta.text !== "") yield { type: "text", text: delta.text };
          }
          break;
        }
        case "message_delta": {
          if (isRecord(data.delta) && typeof data.delta.stop_reason === "string") {
            stopReason = data.delta.stop_reason;
          }
          if (isRecord(data.usage)) outputTokens = count(data.usage.output_tokens) ?? outputTokens;
          break;
        }
        case "message_stop":
          stopped = true;
          break;
        case "error":
          throw errorKindFor(isRecord(data.error) ? data.error.type : undefined);
        default:
          break; // ping, content_block_start/stop, unknown future events
      }
      if (stopped) break;
    }
  } catch (error) {
    throw guard.classify(error);
  }

  if (!stopped) throw new ProviderError("malformed"); // the stream ended early
  if (inputTokens !== null || outputTokens !== null) {
    yield { type: "usage", inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  }
  if (stopReason === "refusal") throw new ProviderError("filtered");
  if (stopReason === "max_tokens") yield { type: "cut_off" };
}

export function createAnthropicAdapter(
  apiKey: Secret<string>,
  model: string,
  deps: ProviderDeps = {},
): ProviderAdapter {
  const endpoint = deps.anthropicEndpoint ?? ANTHROPIC_ENDPOINT;
  return {
    provider: "anthropic",

    async *stream(messages, options) {
      const guard = new RequestGuard(options);
      try {
        const response = await send(
          buildRequest(endpoint, apiKey, model, messages, options, true),
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
          buildRequest(endpoint, apiKey, model, messages, options, false),
          guard,
          deps,
        );
        const data = await readJson(response, guard);
        if (!isRecord(data) || !Array.isArray(data.content)) throw new ProviderError("malformed");
        const text = data.content
          .map((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("");
        if (data.stop_reason === "refusal") throw new ProviderError("filtered");
        const usage = isRecord(data.usage) ? data.usage : {};
        return {
          text,
          inputTokens: count(usage.input_tokens),
          outputTokens: count(usage.output_tokens),
          cutOff: data.stop_reason === "max_tokens",
        };
      } catch (error) {
        throw guard.classify(error);
      } finally {
        guard.dispose();
      }
    },
  };
}
