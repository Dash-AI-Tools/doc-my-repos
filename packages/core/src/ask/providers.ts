/**
 * The providers Ask can use (ask-the-docs design decisions 5 and 9). The set is fixed in code;
 * credentials come from the environment and never appear here. Pure: shared by the server and the
 * admin form.
 */

export const AI_PROVIDERS = ["anthropic", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

const LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible endpoint",
};

/** The name users and admins see for a provider id. */
export function providerLabel(provider: string): string {
  return isAiProvider(provider) ? LABELS[provider] : "the provider";
}

export const MODEL_MAX_LENGTH = 100;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export type ModelCheck =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/**
 * A model name: trimmed, 1 to 100 characters, starting with a letter or digit, then letters,
 * digits and `. _ : / @ + -` (so `llama3.1:8b` and `org/model` pass). No spaces, control or bidi
 * characters. The name is only ever sent as a JSON body field, never in a URL or header.
 */
export function validateModel(raw: unknown): ModelCheck {
  if (typeof raw !== "string") return { ok: false, reason: "must be text" };
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "must not be empty" };
  if (value.length > MODEL_MAX_LENGTH) {
    return { ok: false, reason: `must be at most ${MODEL_MAX_LENGTH} characters` };
  }
  if (!MODEL_PATTERN.test(value)) {
    return {
      ok: false,
      reason:
        "may contain only letters, digits and . _ : / @ + - and must start with a letter or digit",
    };
  }
  return { ok: true, value };
}
