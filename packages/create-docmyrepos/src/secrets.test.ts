import { describe, expect, it } from "vitest";

import { generateSecret } from "./secrets.js";

describe("generateSecret", () => {
  it("is base64url with at least 256 bits", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, "base64url").length).toBeGreaterThanOrEqual(32);
  });

  it("is unique over many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(generateSecret());
    expect(seen.size).toBe(10_000);
  });

  it("refuses less than 256 bits", () => {
    expect(() => generateSecret(16)).toThrow(RangeError);
    expect(() => generateSecret(31.5)).toThrow(RangeError);
    expect(generateSecret(48)).toHaveLength(64);
  });
});
