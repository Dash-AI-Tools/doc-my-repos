import { describe, expect, it } from "vitest";

import { verifySessionEdge } from "./edge-session";
import { newSessionPayload, signSession } from "./session";

const SECRET = "edge-test-secret-0123456789abcdef";

describe("edge session verify (proxy gate)", () => {
  it("accepts cookies signed by the server module", async () => {
    const value = signSession(SECRET, newSessionPayload(7, "user", 3));
    await expect(verifySessionEdge(SECRET, value)).resolves.toMatchObject({
      uid: 7,
      role: "user",
      pwv: 3,
    });
  });

  it("rejects tampered, expired, and malformed cookies", async () => {
    const value = signSession(SECRET, newSessionPayload(1, "admin", 0));
    const [data] = value.split(".");
    await expect(verifySessionEdge(SECRET, `${data}.bogus`)).resolves.toBeNull();
    await expect(verifySessionEdge("other", value)).resolves.toBeNull();
    await expect(verifySessionEdge(SECRET, undefined)).resolves.toBeNull();
    const expired = signSession(SECRET, { uid: 1, role: "user", exp: Date.now() - 1, pwv: 0 });
    await expect(verifySessionEdge(SECRET, expired)).resolves.toBeNull();
  });
});
