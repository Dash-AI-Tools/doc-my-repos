import { checkOpenAiBaseUrl } from "@docmyrepos/core/internal/ask/endpoint";
import type { AiProvider } from "@docmyrepos/core/internal/ask/providers";
import { Secret } from "../config/secret";

/**
 * Whether each Ask provider is usable, and its credentials, from the provider settings an
 * administrator saved (workspace-settings, ai-provider-config). Pure: it never reads the
 * environment, never throws and never includes a value. A provider whose settings are missing or
 * refused is simply not configured, so Ask is unavailable and the portal keeps working.
 */

/** The provider settings as the workspace loads them (keys stay wrapped). */
export interface ProviderSettingsInput {
  readonly anthropicKey: Secret<string> | null;
  readonly openaiKey: Secret<string> | null;
  readonly openaiBaseUrl: string | null;
}

/** Names shown to administrators for what is still to be entered. */
export const PROVIDER_FIELD_LABELS = {
  anthropicKey: "Anthropic API key",
  openaiBaseUrl: "OpenAI-compatible base URL",
  openaiKey: "OpenAI-compatible API key",
} as const;

/**
 * Whether one provider is usable. `missing` names what still has to be entered; `problem` (a fixed
 * text naming the field, never a value) says why a saved value was refused. A provider with a
 * problem is not configured.
 */
export interface ProviderAvailability {
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly problem?: string;
  /** Host name of the endpoint (OpenAI-compatible only); never the full URL. */
  readonly host?: string;
}

export type AllProviderAvailability = Readonly<Record<AiProvider, ProviderAvailability>>;

/** Credentials for one provider, for its adapter. Reveal the key only when sending the request. */
export type ProviderCredentials =
  | { readonly provider: "anthropic"; readonly apiKey: Secret<string> }
  | {
      readonly provider: "openai-compatible";
      readonly baseUrl: URL;
      readonly apiKey: Secret<string> | null;
    };

type GroupResult =
  | { availability: ProviderAvailability; credentials: ProviderCredentials }
  | { availability: ProviderAvailability; credentials: null };

function anthropicGroup(input: ProviderSettingsInput): GroupResult {
  if (input.anthropicKey === null) {
    return {
      availability: { configured: false, missing: [PROVIDER_FIELD_LABELS.anthropicKey] },
      credentials: null,
    };
  }
  return {
    availability: { configured: true, missing: [] },
    credentials: { provider: "anthropic", apiKey: input.anthropicKey },
  };
}

function openAiGroup(input: ProviderSettingsInput): GroupResult {
  const unavailable = (a: Omit<ProviderAvailability, "configured">): GroupResult => ({
    availability: { configured: false, ...a },
    credentials: null,
  });

  if (input.openaiBaseUrl === null) {
    return unavailable({ missing: [PROVIDER_FIELD_LABELS.openaiBaseUrl] });
  }
  const checked = checkOpenAiBaseUrl(input.openaiBaseUrl);
  if (!checked.ok) {
    return unavailable({
      missing: [],
      problem: `${PROVIDER_FIELD_LABELS.openaiBaseUrl} ${checked.problem}`,
    });
  }
  const host = checked.url.hostname;
  if (input.openaiKey === null && !checked.loopback) {
    return unavailable({ missing: [PROVIDER_FIELD_LABELS.openaiKey], host });
  }
  return {
    availability: { configured: true, missing: [], host },
    credentials: { provider: "openai-compatible", baseUrl: checked.url, apiKey: input.openaiKey },
  };
}

export function providerAvailability(input: ProviderSettingsInput): AllProviderAvailability {
  return {
    anthropic: anthropicGroup(input).availability,
    "openai-compatible": openAiGroup(input).availability,
  };
}

/** The credentials for `provider`, or `null` when it is not configured. */
export function providerCredentials(
  input: ProviderSettingsInput,
  provider: AiProvider,
): ProviderCredentials | null {
  return (provider === "anthropic" ? anthropicGroup(input) : openAiGroup(input)).credentials;
}
