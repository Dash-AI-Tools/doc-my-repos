import { randomBytes } from "node:crypto";

/** Smallest generated secret, in bytes of randomness (256 bits). */
export const MIN_SECRET_BYTES = 32;

/**
 * A random secret from the operating system's CSPRNG, as base64url (letters, digits, `-` and `_`,
 * so it is safe in `.env` files, URLs and shells). The default 32 bytes give 43 characters.
 */
export function generateSecret(bytes: number = MIN_SECRET_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < MIN_SECRET_BYTES) {
    throw new RangeError(`a secret needs at least ${MIN_SECRET_BYTES} bytes of randomness`);
  }
  return randomBytes(bytes).toString("base64url");
}
