import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { readWebhookSecret } from "./env";

describe("readWebhookSecret", () => {
  it("returns the trimmed secret as a Secret", () => {
    const secret = readWebhookSecret({ GITHUB_WEBHOOK_SECRET: "  0123456789abcdef \n" });
    expect(secret?.reveal()).toBe("0123456789abcdef");
    expect(inspect(secret)).toBe("[redacted]");
  });

  it("returns null for unset, blank and too short values", () => {
    for (const value of [undefined, "", "   ", "0123456789abcde", " 0123456789abcde "]) {
      expect(readWebhookSecret({ GITHUB_WEBHOOK_SECRET: value })).toBeNull();
    }
    expect(readWebhookSecret({})).toBeNull();
  });

  it("does not read the sync secret", () => {
    expect(readWebhookSecret({ SYNC_SECRET: "0123456789abcdef" })).toBeNull();
  });
});
