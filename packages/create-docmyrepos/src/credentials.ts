/**
 * Credential-pattern guard. Any text that came from outside (GitHub error bodies, container logs)
 * passes through here before it is quoted in output or an error message. The guard fails closed:
 * text that looks like a credential is dropped or masked, never shown.
 */

const PATTERNS: readonly RegExp[] = [
  // GitHub tokens: classic and fine-grained personal, OAuth, user, server, refresh.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  // PEM blocks and key headers.
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  // JWTs (three base64url parts, the first two start with `eyJ`).
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  // Authorization header values.
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // `name=value` or `name: value` pairs that name a secret.
  /\b[A-Za-z_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[A-Za-z_]*\s*[=:]\s*\S{6,}/i,
  // Long opaque tokens (generated secrets are 43 base64url characters). Pure hex of 40 or 64
  // characters (git object ids) is not a credential.
  /(?<![A-Za-z0-9_-])(?![0-9a-f]{40}(?![A-Za-z0-9_-]))(?![0-9a-f]{64}(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/,
];

export function containsCredential(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}

/** The text on one line, shortened, or `null` when it looks like it holds a credential. */
export function safeQuote(text: string, maxLength = 200): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "" || containsCredential(flat)) return null;
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/** Masks credential-looking spans line by line (for log tails, where hiding everything is too much). */
export function redactCredentials(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      containsCredential(line) ? "[line hidden: it looks like it holds a credential]" : line,
    )
    .join("\n");
}
