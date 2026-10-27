import { createHash, timingSafeEqual } from "node:crypto";

import { MIN_SECRET_LENGTH } from "../config/secret";

/**
 * Authentication for the manual sync endpoint (`POST /api/sync`, task 6.1). Pure: no Next.js, no
 * environment, no logging.
 *
 * The one accepted scheme is `Authorization: Bearer <secret>`. The secret is never read from the
 * query string or the body, because URLs end up in access logs and proxies.
 */

/** Longer headers are rejected unread. A real header is the secret plus 7 bytes. */
const MAX_HEADER_LENGTH = 4096;

// RFC 9110: the scheme is case-insensitive, then exactly one space, then the credentials. The
// credentials are one token with no whitespace, so extra spaces, tabs and trailing text fail.
const BEARER = /^bearer ([^\s]+)$/i;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether `headerValue` (the `Authorization` header, or null/undefined when absent) carries
 * `expectedSecret` as a bearer token.
 *
 * Both sides are hashed with SHA-256 and the digests compared with `timingSafeEqual`, so the
 * comparison takes the same time whatever the length or the common prefix of the guess. A missing,
 * empty or malformed header is rejected. An `expectedSecret` that is empty or shorter than the
 * configured minimum never matches, so a misconfiguration cannot open the endpoint. Never throws.
 */
export function verifySyncSecret(
  headerValue: string | null | undefined,
  expectedSecret: string,
): boolean {
  try {
    if (typeof expectedSecret !== "string" || expectedSecret.length < MIN_SECRET_LENGTH) {
      return false;
    }
    if (typeof headerValue !== "string" || headerValue.length > MAX_HEADER_LENGTH) return false;
    const match = BEARER.exec(headerValue);
    const provided = match?.[1];
    if (provided === undefined) return false;
    return timingSafeEqual(digest(provided), digest(expectedSecret));
  } catch {
    return false;
  }
}
