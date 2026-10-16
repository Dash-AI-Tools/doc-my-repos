import { describe, expect, it } from "vitest";

import { parseEnv, providerAvailability, providerCredentials, type EnvSource } from "./env";

const KEY = "sk-test-0123456789abcdef";

function availability(env: EnvSource) {
  return providerAvailability(env);
}

describe("providerAvailability: anthropic", () => {
  it("is not configured without a key and names the variable", () => {
    expect(availability({}).anthropic).toEqual({
      configured: false,
      missing: ["AI_ANTHROPIC_API_KEY"],
    });
    expect(availability({ AI_ANTHROPIC_API_KEY: "   " }).anthropic.missing).toEqual([
      "AI_ANTHROPIC_API_KEY",
    ]);
  });

  it("is configured with a key", () => {
    expect(availability({ AI_ANTHROPIC_API_KEY: KEY }).anthropic).toEqual({
      configured: true,
      missing: [],
    });
  });
});

describe("providerAvailability: openai-compatible", () => {
  const openai = (env: EnvSource) => availability(env)["openai-compatible"];

  it("is not configured without a base URL", () => {
    expect(openai({})).toEqual({ configured: false, missing: ["AI_OPENAI_BASE_URL"] });
    expect(openai({ AI_OPENAI_API_KEY: KEY }).missing).toEqual(["AI_OPENAI_BASE_URL"]);
  });

  it("accepts an https URL with a key and reports only the host", () => {
    expect(
      openai({ AI_OPENAI_BASE_URL: "https://models.example.com/v1", AI_OPENAI_API_KEY: KEY }),
    ).toEqual({ configured: true, missing: [], host: "models.example.com" });
  });

  it("requires a key for a remote endpoint", () => {
    expect(openai({ AI_OPENAI_BASE_URL: "https://models.example.com/v1" })).toEqual({
      configured: false,
      missing: ["AI_OPENAI_API_KEY"],
      host: "models.example.com",
    });
  });

  it("accepts http loopback addresses without a key", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:8000/v1",
      "http://[::1]:8000/v1",
      "http://127.1.2.3/v1",
    ]) {
      expect(openai({ AI_OPENAI_BASE_URL: url }).configured).toBe(true);
    }
  });

  it("refuses http for a remote host, naming the variable", () => {
    const result = openai({
      AI_OPENAI_BASE_URL: "http://models.example.com",
      AI_OPENAI_API_KEY: KEY,
    });
    expect(result.configured).toBe(false);
    expect(result.problem).toMatch(/^AI_OPENAI_BASE_URL: must be an https URL/);
  });

  it("refuses look-alike loopback names and other schemes", () => {
    for (const url of [
      "http://127.0.0.1.evil.com/v1",
      "http://localhost.evil.com/v1",
      "ftp://127.0.0.1/v1",
      "file:///etc/passwd",
    ]) {
      expect(openai({ AI_OPENAI_BASE_URL: url, AI_OPENAI_API_KEY: KEY }).configured).toBe(false);
    }
  });

  it("refuses a URL that is not a URL or carries credentials", () => {
    expect(openai({ AI_OPENAI_BASE_URL: "not a url" }).problem).toBe(
      "AI_OPENAI_BASE_URL: is not a valid URL",
    );
    expect(
      openai({ AI_OPENAI_BASE_URL: "https://user:hunter2@models.example.com/v1" }).problem,
    ).toMatch(/^AI_OPENAI_BASE_URL: must not contain a username or password/);
  });

  it("never puts a value in a problem or missing list", () => {
    const secretish = "https://user:hunter2-secret@models.example.com/v1?token=abc123";
    const all = JSON.stringify(
      availability({ AI_OPENAI_BASE_URL: secretish, AI_OPENAI_API_KEY: KEY }),
    );
    for (const leaked of ["hunter2", "abc123", KEY]) expect(all).not.toContain(leaked);
  });
});

describe("providerCredentials", () => {
  it("returns null for a group that is not configured, so it is treated as absent", () => {
    expect(providerCredentials({}, "anthropic")).toBeNull();
    expect(
      providerCredentials({ AI_OPENAI_BASE_URL: "http://models.example.com" }, "openai-compatible"),
    ).toBeNull();
  });

  it("wraps keys in Secret so they cannot be logged by accident", () => {
    const anthropic = providerCredentials({ AI_ANTHROPIC_API_KEY: KEY }, "anthropic");
    expect(anthropic?.apiKey?.reveal()).toBe(KEY);
    expect(String(anthropic?.apiKey)).not.toContain(KEY);
    expect(JSON.stringify(anthropic)).not.toContain(KEY);

    const local = providerCredentials(
      { AI_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" },
      "openai-compatible",
    );
    expect(local).toMatchObject({ provider: "openai-compatible", apiKey: null });
  });

  it("one invalid group does not affect the other", () => {
    const env = { AI_ANTHROPIC_API_KEY: KEY, AI_OPENAI_BASE_URL: "http://models.example.com" };
    expect(providerAvailability(env).anthropic.configured).toBe(true);
    expect(providerAvailability(env)["openai-compatible"].configured).toBe(false);
  });
});

describe("an invalid AI setting does not stop the portal", () => {
  it("parseEnv reports no problem for AI variables, valid or not", () => {
    const base = {
      DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "x",
      GITHUB_APP_INSTALLATION_ID: "67890",
      GITHUB_WEBHOOK_SECRET: "webhook-secret-0123",
      SYNC_SECRET: "sync-secret-0123456",
      SESSION_SECRET: "session-secret-01234567890",
    };
    const readFile = () => "";
    const clean = parseEnv(base, readFile).problems;
    const withBadAi = parseEnv(
      { ...base, AI_OPENAI_BASE_URL: "http://models.example.com", AI_ANTHROPIC_API_KEY: "" },
      readFile,
    ).problems;
    expect(withBadAi).toEqual(clean);
  });
});
