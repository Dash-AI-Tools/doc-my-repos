import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv, readSyncSecret, readWebhookSecret } from "./env";

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
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY: "not-a-key",
};

function problemsFor(overrides: Record<string, string>): string[] {
  return [
    ...parseEnv({ ...baseEnv, ...overrides }, () => {
      throw new Error("no files in this test");
    }).problems,
  ];
}

describe("placeholder shared secrets", () => {
  it("readSyncSecret and readWebhookSecret reject placeholders", () => {
    for (const value of PLACEHOLDERS) {
      expect(readSyncSecret({ SYNC_SECRET: value })).toBeNull();
      expect(readWebhookSecret({ GITHUB_WEBHOOK_SECRET: value })).toBeNull();
    }
  });

  it("still accepts a real secret that merely contains the words", () => {
    expect(readSyncSecret({ SYNC_SECRET: "my-replace-with-this-0123456" })?.reveal()).toBe(
      "my-replace-with-this-0123456",
    );
  });

  it("parseEnv reports the placeholder by variable name without echoing the value", () => {
    for (const value of PLACEHOLDERS) {
      const problems = problemsFor({
        SYNC_SECRET: value,
        GITHUB_WEBHOOK_SECRET: "0123456789abcdef0123",
      });
      const line = problems.find((p) => p.startsWith("SYNC_SECRET:"));
      expect(line).toMatch(/placeholder/);
      expect(problems.join("\n")).not.toContain(value.trim());
    }
    const webhook = problemsFor({
      SYNC_SECRET: "0123456789abcdef0123",
      GITHUB_WEBHOOK_SECRET: "replace-with-webhook-secret",
    });
    expect(webhook.find((p) => p.startsWith("GITHUB_WEBHOOK_SECRET:"))).toMatch(/placeholder/);
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
    expect(readWebhookSecret({ GITHUB_WEBHOOK_SECRET: get("GITHUB_WEBHOOK_SECRET") })).toBeNull();
  });
});
