import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { Secret } from "../config/secret";

/**
 * Encryption of stored secrets (workspace-settings design decision 2). AES-256-GCM with a fresh
 * 12-byte nonce per value and the secret's name as additional authenticated data, so a value copied
 * into another row fails to decrypt. The key comes only from the operator's environment; messages
 * here are fixed text and never include a key, a nonce, a cipher text or a plain value.
 */

export const ENCRYPTION_KEY_VAR = "SETTINGS_ENCRYPTION_KEY";
/** The only key version that exists; stored with every value so a later rotation can tell. */
export const CURRENT_KEY_VERSION = 1;

const MIN_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** The derived AES key, kept wrapped so it cannot be logged by accident. */
export type EncryptionKey = Secret<Buffer>;

export interface EncryptedValue {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly keyVersion: number;
}

/** A stored value could not be decrypted: wrong key, moved to another name, or damaged. */
export class SecretUnreadableError extends Error {
  constructor() {
    super("A stored secret could not be decrypted");
    this.name = "SecretUnreadableError";
  }
}

/**
 * The key from the environment value: base64 (or base64url) that decodes to at least 32 bytes. The
 * AES key is derived with HKDF, so any long random value works. Returns a problem text naming the
 * variable, never the value.
 */
export function parseEncryptionKey(
  value: string | undefined,
): { key: EncryptionKey; problem: null } | { key: null; problem: string } {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return { key: null, problem: `${ENCRYPTION_KEY_VAR}: is not set` };
  if (!BASE64.test(trimmed)) {
    return { key: null, problem: `${ENCRYPTION_KEY_VAR}: must be base64 text` };
  }
  const raw = Buffer.from(trimmed, "base64");
  if (raw.length < MIN_KEY_BYTES) {
    return {
      key: null,
      problem: `${ENCRYPTION_KEY_VAR}: must decode to at least ${MIN_KEY_BYTES} bytes (for example \`openssl rand -base64 32\`)`,
    };
  }
  const derived = Buffer.from(
    hkdfSync("sha256", raw, Buffer.alloc(0), "docmyrepos-workspace-settings-v1", 32),
  );
  return { key: new Secret(derived), problem: null };
}

/**
 * The key from a startup configuration's `SETTINGS_ENCRYPTION_KEY`. The one reader of that
 * variable: `loadConfig` uses it for the default secrets adapter, and code that runs without an
 * application (the built-in tenant only) falls back to it.
 */
export function encryptionKeyFrom(
  source: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof parseEncryptionKey> {
  return parseEncryptionKey(source[ENCRYPTION_KEY_VAR]);
}

export function encryptSecret(key: EncryptionKey, name: string, plain: string): EncryptedValue {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.reveal(), nonce);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    ciphertext: body.toString("base64"),
    nonce: nonce.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/** Throws `SecretUnreadableError` (fixed text) for any failure. */
export function decryptSecret(key: EncryptionKey, name: string, value: EncryptedValue): string {
  try {
    if (value.keyVersion !== CURRENT_KEY_VERSION) throw new Error("key version");
    const nonce = Buffer.from(value.nonce, "base64");
    const body = Buffer.from(value.ciphertext, "base64");
    if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) throw new Error("shape");
    const decipher = createDecipheriv("aes-256-gcm", key.reveal(), nonce);
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // The crypto error is dropped on purpose: only a fixed message leaves this function.
    throw new SecretUnreadableError();
  }
}
