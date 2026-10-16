import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv, readSyncSecret } from "./env";
import { secretProblem } from "../settings/secret-validation";

// `.env.example` ships `replace-with-...` placeholders that are long enough for the length check.
// A deployment that forgot to change one would be guarded by a public secret, so they are rejected.
const PLACEHOLDERS = [
  "replace-with-sync-secret",
  "replace-with-webhook-secret",
  "REPLACE-WITH-SOMETHING-LONG",
  "  replace-with-your-own-secret-value  ",
];

const baseEnv = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
  SESSION_SECRET: "session-secret-01234567890",
};

function problemsFor(overrides: Record<string, string>): string[] {
  return [...parseEnv({ ...baseEnv, ...overrides }).problems];
}

describe("placeholder shared secrets", () => {
  it("readSyncSecret and the webhook secret check reject placeholders", () => {
    for (const value of PLACEHOLDERS) {
      expect(readSyncSecret({ SYNC_SECRET: value })).toBeNull();
      expect(secretProblem("github_webhook_secret", value)).toMatch(/placeholder|at least/);
    }
  });

  it("still accepts a real secret that merely contains the words", () => {
    expect(readSyncSecret({ SYNC_SECRET: "my-replace-with-this-0123456" })?.reveal()).toBe(
      "my-replace-with-this-0123456",
    );
  });

  it("parseEnv reports the placeholder by variable name without echoing the value", () => {
    for (const value of PLACEHOLDERS) {
      const problems = problemsFor({ SYNC_SECRET: value });
      const line = problems.find((p) => p.startsWith("SYNC_SECRET:"));
      expect(line).toMatch(/placeholder/);
      expect(problems.join("\n")).not.toContain(value.trim());
    }
  });

  it("the values shipped in .env.example are rejected", () => {
    const text = readFileSync(resolve(__dirname, "../../../.env.example"), "utf8");
    const get = (name: string) =>
      text
        .split("\n")
        .find((l) => l.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim();
    expect(readSyncSecret({ SYNC_SECRET: get("SYNC_SECRET") })).toBeNull();
  });
});
