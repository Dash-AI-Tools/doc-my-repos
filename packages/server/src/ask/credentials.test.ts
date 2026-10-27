import { describe, expect, it } from "vitest";

import { Secret } from "../config/secret";
import {
  providerAvailability,
  providerCredentials,
  type ProviderSettingsInput,
} from "./credentials";

const KEY = "sk-test-0123456789abcdef";
const key = (v: string | null = KEY) => (v === null ? null : new Secret(v));

const input = (over: Partial<ProviderSettingsInput> = {}): ProviderSettingsInput => ({
  anthropicKey: null,
  openaiKey: null,
  openaiBaseUrl: null,
  ...over,
});

describe("providerAvailability: anthropic", () => {
  it("is not configured without a key and names the setting", () => {
    expect(providerAvailability(input()).anthropic).toEqual({
      configured: false,
      missing: ["Anthropic API key"],
    });
  });

  it("is configured with a key", () => {
    expect(providerAvailability(input({ anthropicKey: key() })).anthropic).toEqual({
      configured: true,
      missing: [],
    });
  });
});

describe("providerAvailability: openai-compatible", () => {
  const openai = (over: Partial<ProviderSettingsInput>) =>
    providerAvailability(input(over))["openai-compatible"];

  it("is not configured without a base URL", () => {
    expect(openai({})).toEqual({ configured: false, missing: ["OpenAI-compatible base URL"] });
    expect(openai({ openaiKey: key() }).missing).toEqual(["OpenAI-compatible base URL"]);
  });

  it("accepts an https URL with a key and reports only the host", () => {
    expect(openai({ openaiBaseUrl: "https://models.example.com/v1", openaiKey: key() })).toEqual({
      configured: true,
      missing: [],
      host: "models.example.com",
    });
  });

  it("requires a key for a remote endpoint", () => {
    expect(openai({ openaiBaseUrl: "https://models.example.com/v1" })).toEqual({
      configured: false,
      missing: ["OpenAI-compatible API key"],
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
      expect(openai({ openaiBaseUrl: url }).configured).toBe(true);
    }
  });

  it("refuses http for a remote host, naming the field", () => {
    const result = openai({ openaiBaseUrl: "http://models.example.com", openaiKey: key() });
    expect(result.configured).toBe(false);
    expect(result.problem).toMatch(/^OpenAI-compatible base URL must be an https URL/);
  });

  it("refuses look-alike loopback names and other schemes", () => {
    for (const url of [
      "http://127.0.0.1.evil.com/v1",
      "http://localhost.evil.com/v1",
      "ftp://127.0.0.1/v1",
      "file:///etc/passwd",
    ]) {
      expect(openai({ openaiBaseUrl: url, openaiKey: key() }).configured).toBe(false);
    }
  });

  it("refuses a URL that is not a URL or carries credentials", () => {
    expect(openai({ openaiBaseUrl: "not a url" }).problem).toBe(
      "OpenAI-compatible base URL is not a valid URL",
    );
    expect(openai({ openaiBaseUrl: "https://user:hunter2@models.example.com/v1" }).problem).toMatch(
      /^OpenAI-compatible base URL must not contain a username or password/,
    );
  });

  it("never puts a value in a problem or missing list", () => {
    const secretish = "https://user:hunter2-secret@models.example.com/v1?token=abc123";
    const all = JSON.stringify(
      providerAvailability(input({ openaiBaseUrl: secretish, openaiKey: key() })),
    );
    for (const leaked of ["hunter2", "abc123", KEY]) expect(all).not.toContain(leaked);
  });
});

describe("providerCredentials", () => {
  it("returns null for a group that is not configured, so it is treated as absent", () => {
    expect(providerCredentials(input(), "anthropic")).toBeNull();
    expect(
      providerCredentials(
        input({ openaiBaseUrl: "http://models.example.com" }),
        "openai-compatible",
      ),
    ).toBeNull();
  });

  it("keeps keys wrapped in Secret so they cannot be logged by accident", () => {
    const anthropic = providerCredentials(input({ anthropicKey: key() }), "anthropic");
    expect(anthropic?.apiKey?.reveal()).toBe(KEY);
    expect(String(anthropic?.apiKey)).not.toContain(KEY);
    expect(JSON.stringify(anthropic)).not.toContain(KEY);

    const local = providerCredentials(
      input({ openaiBaseUrl: "http://127.0.0.1:11434/v1" }),
      "openai-compatible",
    );
    expect(local).toMatchObject({ provider: "openai-compatible", apiKey: null });
  });

  it("one invalid group does not affect the other", () => {
    const both = input({ anthropicKey: key(), openaiBaseUrl: "http://models.example.com" });
    expect(providerAvailability(both).anthropic.configured).toBe(true);
    expect(providerAvailability(both)["openai-compatible"].configured).toBe(false);
  });
});
