import { createHmac, timingSafeEqual } from "node:crypto";

import { MIN_SECRET_LENGTH } from "../config/secret";

/**
 * GitHub webhook signature verification (task 6.2). Pure: no Next.js, no environment, no logging.
 *
 * GitHub signs every delivery with HMAC-SHA256 over the exact bytes of the request body, keyed with
 * the App's webhook secret, and sends it as `X-Hub-Signature-256: sha256=<64 lowercase hex>`.
 *
 * Why `node:crypto` and not `@octokit/webhooks` (`verify`): the Octokit helper takes the payload as
 * a string, so the body would have to be decoded and re-encoded before hashing, and invalid UTF-8
 * would be replaced on the way. Hashing the raw bytes is what GitHub signs, it is these few lines,
 * and it adds no dependency. The comparison is the same as Octokit's (`timingSafeEqual` on buffers
 * of equal length).
 *
 * Decisions:
 * - Only `sha256=` is accepted. The legacy `X-Hub-Signature: sha1=...` header is never read, so a
 *   request that carries only that one is rejected like an unsigned one.
 * - The hex must be exactly 64 lowercase characters, as GitHub sends it. Uppercase, odd length,
 *   wrong length, whitespace inside, or a second value (a repeated header joins as `a, b`) fail.
 * - A secret that is not a string, is empty or is shorter than `MIN_SECRET_LENGTH` never verifies,
 *   so a misconfiguration cannot open the endpoint.
 */

/** The header GitHub puts the SHA-256 signature in (lower case, as `Headers.get` accepts). */
export const SIGNATURE_HEADER = "x-hub-signature-256";

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * Whether `signatureHeader` is GitHub's signature of `rawBody` under `secret`. `rawBody` must be
 * the body exactly as received, never a re-serialised or decoded copy. Never throws.
 *
 * The expected and provided digests are both 32 bytes and are compared with `timingSafeEqual`, so
 * the time taken does not depend on how much of a guess is right. Malformed headers are rejected
 * before any hashing; that only depends on the header's shape, not on the secret.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  try {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return false;
    if (!(rawBody instanceof Uint8Array)) return false;
    if (typeof signatureHeader !== "string") return false;
    const hex = SIGNATURE.exec(signatureHeader)?.[1];
    if (hex === undefined) return false;
    const provided = Buffer.from(hex, "hex");
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
