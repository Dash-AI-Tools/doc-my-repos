import { describe, expect, it } from "vitest";

import { newSessionPayload, signSession, verifySession } from "./session";

const SECRET = "test-secret-1234567890abcdef";

describe("session cookies", () => {
  it("round-trips a valid session", () => {
    const value = signSession(SECRET, newSessionPayload(1, "admin", 0));
    expect(verifySession(SECRET, value)).toMatchObject({ uid: 1, role: "admin", pwv: 0 });
  });

  it("rejects tampered payloads and wrong secrets", () => {
    const value = signSession(SECRET, newSessionPayload(1, "user", 0));
    const [data, sig] = value.split(".");
    const forged =
      Buffer.from(
        JSON.stringify({ uid: 2, role: "admin", exp: Date.now() + 9999, pwv: 0 }),
      ).toString("base64url") + `.${sig}`;
    expect(verifySession(SECRET, forged)).toBeNull();
    expect(verifySession(SECRET, `${data}.bogus`)).toBeNull();
    expect(verifySession("other-secret", value)).toBeNull();
  });

  it("rejects expired and malformed values", () => {
    const expired = signSession(SECRET, { uid: 1, role: "user", exp: Date.now() - 1, pwv: 0 });
    expect(verifySession(SECRET, expired)).toBeNull();
    expect(verifySession(SECRET, undefined)).toBeNull();
    expect(verifySession(SECRET, "no-dot")).toBeNull();
    expect(verifySession("", signSession(SECRET, newSessionPayload(1, "user", 0)))).toBeNull();
  });
});
