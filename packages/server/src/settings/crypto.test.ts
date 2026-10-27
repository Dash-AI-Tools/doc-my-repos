import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  SecretUnreadableError,
  type EncryptionKey,
} from "./crypto";

const keyOf = (bytes = 32): EncryptionKey => {
  const parsed = parseEncryptionKey(randomBytes(bytes).toString("base64"));
  if (parsed.key === null) throw new Error("test key rejected");
  return parsed.key;
};

describe("parseEncryptionKey", () => {
  it("accepts base64 that decodes to at least 32 bytes", () => {
    expect(parseEncryptionKey(randomBytes(32).toString("base64")).key).not.toBeNull();
    expect(parseEncryptionKey(randomBytes(64).toString("base64url")).key).not.toBeNull();
    expect(parseEncryptionKey(`  ${randomBytes(32).toString("base64")}\n`).key).not.toBeNull();
  });

  it.each([undefined, "", "   "])("rejects an unset key (%j)", (value) => {
    const result = parseEncryptionKey(value);
    expect(result.key).toBeNull();
    expect(result.problem).toBe("SETTINGS_ENCRYPTION_KEY: is not set");
  });

  it("rejects text that is not base64, and keys that are too short, without echoing them", () => {
    const secretish = "not base64 !!! hunter2-hunter2";
    const bad = parseEncryptionKey(secretish);
    expect(bad.problem).toMatch(/must be base64/);
    expect(bad.problem).not.toContain("hunter2");

    const shortKey = randomBytes(16).toString("base64");
    const short = parseEncryptionKey(shortKey);
    expect(short.problem).toMatch(/at least 32 bytes/);
    expect(short.problem).not.toContain(shortKey);
  });

  it("keeps the derived key out of logs and JSON", () => {
    const { key } = parseEncryptionKey(randomBytes(32).toString("base64"));
    expect(JSON.stringify({ key })).toBe('{"key":"[redacted]"}');
    expect(String(key)).toBe("[redacted]");
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips, with a fresh nonce each time and no clear text in the output", () => {
    const key = keyOf();
    const plain = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    const a = encryptSecret(key, "github_private_key", plain);
    const b = encryptSecret(key, "github_private_key", plain);
    expect(decryptSecret(key, "github_private_key", a)).toBe(plain);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain("PRIVATE KEY");
    expect(a.keyVersion).toBe(1);
  });

  it("fails closed for a tampered ciphertext, a wrong key and a moved value", () => {
    const key = keyOf();
    const stored = encryptSecret(key, "anthropic_api_key", "sk-secret-value");

    const flipped = Buffer.from(stored.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() =>
      decryptSecret(key, "anthropic_api_key", {
        ...stored,
        ciphertext: flipped.toString("base64"),
      }),
    ).toThrow(SecretUnreadableError);

    expect(() => decryptSecret(keyOf(), "anthropic_api_key", stored)).toThrow(
      SecretUnreadableError,
    );
    expect(() => decryptSecret(key, "openai_api_key", stored)).toThrow(SecretUnreadableError);
    expect(() => decryptSecret(key, "anthropic_api_key", { ...stored, keyVersion: 2 })).toThrow(
      SecretUnreadableError,
    );
    expect(() =>
      decryptSecret(key, "anthropic_api_key", { ...stored, nonce: "AAAA", ciphertext: "AA" }),
    ).toThrow(SecretUnreadableError);
  });

  it("uses a fixed error message that holds no secret", () => {
    const key = keyOf();
    const stored = encryptSecret(key, "openai_api_key", "sk-secret-value");
    try {
      decryptSecret(keyOf(), "openai_api_key", stored);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toBe("SecretUnreadableError: A stored secret could not be decrypted");
    }
  });
});
