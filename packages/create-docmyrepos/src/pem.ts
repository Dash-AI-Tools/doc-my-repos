import { createPrivateKey } from "node:crypto";

// Same rules as `pemProblem` in `src/server/config/env.ts`; the agreement test compares them.
const PEM_PATTERN =
  /^-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n:, -]+?)\r?\n-----END \1-----$/;
const ACCEPTED_LABELS = new Set(["RSA PRIVATE KEY", "PRIVATE KEY"]);

/**
 * Checks that `pem` is an unencrypted RSA private key (PKCS#1 or PKCS#8, as GitHub issues) and
 * returns a problem description, or `null` when usable. The text is fixed and never includes any
 * part of the key.
 */
export function pemProblem(pem: string): string | null {
  const match = PEM_PATTERN.exec(pem.trim());
  if (!match) {
    return "is not a PEM private key (expected a -----BEGIN ... PRIVATE KEY----- block)";
  }
  const label = match[1] ?? "";
  if (label === "ENCRYPTED PRIVATE KEY" || /^Proc-Type:.*ENCRYPTED/m.test(match[2] ?? "")) {
    return "is an encrypted private key; provide the unencrypted key GitHub issued";
  }
  if (!ACCEPTED_LABELS.has(label)) {
    return "is not a PEM private key (expected RSA PRIVATE KEY or PRIVATE KEY)";
  }
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey({ key: pem.trim(), format: "pem" }).asymmetricKeyType;
  } catch {
    // The crypto error is dropped on purpose: only a fixed message leaves this function.
    return "is not a valid PEM private key (the key data could not be parsed)";
  }
  if (keyType !== "rsa") return "is not an RSA private key (GitHub App keys are RSA)";
  return null;
}

/** Trims the key and turns literal `\n` escapes into newlines, as the app does for an inline key. */
export function normalizePem(text: string): string {
  return text.replace(/\\r\\n|\\n/g, "\n").trim();
}
