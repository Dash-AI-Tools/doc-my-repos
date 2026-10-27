import { describe, expect, it } from "vitest";

import { parseEnv, retiredEnvVars, retiredSources } from "./env";

const BASE = {
  DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
};

describe("auth env", () => {
  it("accepts a valid environment and no bootstrap admin", () => {
    const result = parseEnv({ ...BASE, ADMIN_EMAIL: undefined });
    expect(result.problems).toEqual([]);
    expect(result.env?.adminEmail).toBeNull();
    expect(result.env?.sessionSecret.reveal()).toBe(BASE.SESSION_SECRET);
  });

  it("names a missing SESSION_SECRET without echoing anything", () => {
    const result = parseEnv({ ...BASE, SESSION_SECRET: undefined });
    expect(result.problems).toContain("SESSION_SECRET: is not set");
    expect(result.env).toBeNull();
  });

  it("rejects a half-set bootstrap admin", () => {
    const result = parseEnv({ ...BASE, ADMIN_EMAIL: "admin@example.com" });
    expect(result.problems).toContain(
      "ADMIN_EMAIL, ADMIN_PASSWORD: set both or neither (bootstrap admin)",
    );
  });

  it("does not ask for GitHub, webhook or provider variables any more", () => {
    expect(parseEnv(BASE).problems).toEqual([]);
  });
});

describe("retiredEnvVars", () => {
  it("names the retired variables that are still set, never their values", () => {
    const found = retiredEnvVars({
      ...BASE,
      GITHUB_APP_ID: "12345",
      GITHUB_WEBHOOK_SECRET: "hunter2-hunter2-hunter2",
      AI_ANTHROPIC_API_KEY: "  ",
      CONFIG_PATH: "docmyrepos.config.yml",
    });
    expect(found).toEqual(["GITHUB_APP_ID", "GITHUB_WEBHOOK_SECRET", "CONFIG_PATH"]);
    expect(JSON.stringify(found)).not.toContain("hunter2");
  });

  it("is empty for a clean environment", () => {
    expect(retiredEnvVars(BASE)).toEqual([]);
  });
});

describe("retiredSources", () => {
  it("adds the default config file when it exists in the working directory", () => {
    const seen: string[] = [];
    const found = retiredSources({ ...BASE, GITHUB_APP_ID: "1" }, "/srv/app", (path) => {
      seen.push(path);
      return true;
    });
    expect(found).toEqual(["GITHUB_APP_ID", "docmyrepos.config.yml"]);
    expect(seen).toEqual(["/srv/app/docmyrepos.config.yml"]);
  });

  it("is empty for a clean environment and no file", () => {
    expect(retiredSources(BASE, "/srv/app", () => false)).toEqual([]);
  });
});
