import type { ProviderCredentials } from "../../config/env";
import { createAnthropicAdapter } from "./anthropic";
import { createOpenAiCompatibleAdapter } from "./openai-compatible";
import type { ProviderAdapter, ProviderDeps } from "./types";

export { ProviderError, type ProviderErrorKind } from "./shared";
export type {
  CompleteOptions,
  CompleteResult,
  ProviderAdapter,
  ProviderDeps,
  ProviderEvent,
  ProviderMessage,
} from "./types";

/** The adapter for `credentials`, requesting `model`. The model is only ever a JSON body field. */
export function createProvider(
  credentials: ProviderCredentials,
  model: string,
  deps: ProviderDeps = {},
): ProviderAdapter {
  return credentials.provider === "anthropic"
    ? createAnthropicAdapter(credentials.apiKey, model, deps)
    : createOpenAiCompatibleAdapter(credentials.baseUrl, credentials.apiKey, model, deps);
}
