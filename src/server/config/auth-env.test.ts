import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

const BASE = {
  DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY_PATH: "",
  GITHUB_APP_INSTALLATION_ID: "67890",
  GITHUB_WEBHOOK_SECRET: "webhook-secret-0123",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};

const readFile = () => {
  throw Object.assign(new Error("no reads expected"), { code: "ENOENT" });
};

describe("auth env", () => {
  it("accepts a valid session secret and no bootstrap admin", () => {
    const result = parseEnv(
      { ...BASE, GITHUB_APP_PRIVATE_KEY: "x", ADMIN_EMAIL: undefined },
      readFile,
    );
    // Private key "x" is invalid; only assert the session/admin problems are absent.
    expect(result.problems.filter((p) => p.startsWith("SESSION_SECRET"))).toEqual([]);
    expect(result.problems.filter((p) => p.startsWith("ADMIN_"))).toEqual([]);
  });

  it("names a missing SESSION_SECRET without echoing anything", () => {
    const env = { ...BASE, SESSION_SECRET: undefined };
    const result = parseEnv({ ...env, GITHUB_APP_PRIVATE_KEY: "x" }, readFile);
    expect(result.problems).toContain("SESSION_SECRET: is not set");
  });

  it("rejects a half-set bootstrap admin", () => {
    const result = parseEnv(
      { ...BASE, GITHUB_APP_PRIVATE_KEY: "x", ADMIN_EMAIL: "admin@example.com" },
      readFile,
    );
    expect(result.problems).toContain(
      "ADMIN_EMAIL, ADMIN_PASSWORD: set both or neither (bootstrap admin)",
    );
  });
});
