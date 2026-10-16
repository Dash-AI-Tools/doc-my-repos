import { pemProblem } from "../config/env";
import { MIN_SECRET_LENGTH } from "../config/secret";
import type { WorkspaceSecretName } from "../db/schema";

/**
 * Checks of a secret an administrator submits (workspace-settings task 2.2). Each returns a fixed
 * problem text, or `null` when the value is usable. Texts name the setting and never include any
 * part of the value.
 */

const PLACEHOLDER_SECRET = /^replace-with-/i;
const MAX_API_KEY_CHARS = 512;

export const SECRET_LABELS: Readonly<Record<WorkspaceSecretName, string>> = {
  github_private_key: "GitHub App private key",
  github_webhook_secret: "GitHub webhook secret",
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI-compatible API key",
};

export function secretProblem(name: WorkspaceSecretName, value: string): string | null {
  const text = value.trim();
  if (text === "") return `${SECRET_LABELS[name]}: must not be empty`;
  switch (name) {
    case "github_private_key": {
      const problem = pemProblem(text);
      return problem === null ? null : `${SECRET_LABELS[name]}: ${problem}`;
    }
    case "github_webhook_secret":
      if (text.length < MIN_SECRET_LENGTH) {
        return `${SECRET_LABELS[name]}: must be at least ${MIN_SECRET_LENGTH} characters`;
      }
      if (PLACEHOLDER_SECRET.test(text)) {
        return `${SECRET_LABELS[name]}: is a placeholder; use the secret configured on the GitHub App`;
      }
      return null;
    case "anthropic_api_key":
    case "openai_api_key":
      if (/[\s\u0000-\u001f\u007f]/.test(text)) {
        return `${SECRET_LABELS[name]}: must not contain spaces or control characters`;
      }
      if (text.length > MAX_API_KEY_CHARS) {
        return `${SECRET_LABELS[name]}: is too long`;
      }
      return null;
  }
}

/** The value as it is stored: trimmed, and a private key with real line breaks. */
export function normalizeSecret(name: WorkspaceSecretName, value: string): string {
  const text = value.trim();
  return name === "github_private_key"
    ? text.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n")
    : text;
}
