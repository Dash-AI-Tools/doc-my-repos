/**
 * Edge-safe session check for `src/proxy.ts` (no `node:` imports: middleware cannot use them).
 * Mirrors the cookie format of `session.ts` (`base64url(json).base64url(hmac-sha256)`) using
 * WebCrypto, which exists in both runtimes. It checks signature + expiry only; the database
 * re-check (disabled, password version, role) happens server-side in `current-user.ts`, which is
 * the source of truth. A forged cookie only earns a redirect back to `/login`.
 */

/** The session cookie's name. */
export const SESSION_COOKIE = "dmr_session";

export interface EdgeSession {
  uid: number;
  role: "admin" | "user";
  exp: number;
  pwv: number;
}

function b64urlDecode(s: string): string {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = b64urlDecode(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Null on tampered/expired/malformed. Never throws. */
export async function verifySessionEdge(
  secret: string,
  value: string | undefined,
): Promise<EdgeSession | null> {
  try {
    if (!secret || !value) return null;
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const data = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(data),
    );
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(data)) as EdgeSession;
    if (
      typeof payload.uid !== "number" ||
      (payload.role !== "admin" && payload.role !== "user") ||
      typeof payload.exp !== "number" ||
      typeof payload.pwv !== "number" ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    // The HMAC already passed, so the payload came from us; the shape check above still
    // fails closed on anything unexpected.
    return payload;
  } catch {
    return null;
  }
}
