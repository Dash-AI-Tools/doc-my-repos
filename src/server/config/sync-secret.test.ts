import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { readSyncSecret } from "./env";

describe("readSyncSecret", () => {
  it("returns the trimmed secret as a Secret", () => {
    const secret = readSyncSecret({ SYNC_SECRET: "  0123456789abcdef \n" });
    expect(secret?.reveal()).toBe("0123456789abcdef");
    expect(inspect(secret)).toBe("[redacted]");
  });

  it("returns null for unset, blank and too short values", () => {
    for (const value of [undefined, "", "   ", "0123456789abcde", " 0123456789abcde "]) {
      expect(readSyncSecret({ SYNC_SECRET: value })).toBeNull();
    }
    expect(readSyncSecret({})).toBeNull();
  });
});
