import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "dmr_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  uid: number;
  role: "admin" | "user";
  exp: number;
  pwv: number;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function signature(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Create a `payload.sig` cookie value. Exported for tests. */
export function signSession(secret: string, payload: SessionPayload): string {
  const data = b64urlEncode(JSON.stringify(payload));
  return `${data}.${signature(secret, data)}`;
}

/** Verify a cookie value; null on tampered/expired/malformed. Never throws. */
export function verifySession(secret: string, value: string | undefined): SessionPayload | null {
  if (!secret || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const data = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(sig, "base64url");
    b = Buffer.from(signature(secret, data), "base64url");
  } catch {
    return null;
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(data)) as SessionPayload;
    if (
      typeof payload.uid !== "number" ||
      (payload.role !== "admin" && payload.role !== "user") ||
      typeof payload.exp !== "number" ||
      typeof payload.pwv !== "number" ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function newSessionPayload(
  uid: number,
  role: "admin" | "user",
  pwv: number,
): SessionPayload {
  return { uid, role, exp: Date.now() + SESSION_TTL_MS, pwv };
}

export function sessionCookieHeader(value: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=604800",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
