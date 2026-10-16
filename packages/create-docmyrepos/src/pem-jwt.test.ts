import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAppJwt } from "./jwt.js";
import { normalizePem, pemProblem } from "./pem.js";
import { rsaPem } from "./test-support.js";

/** The base64 body lines of a PEM, which must never appear in a message. */
function body(pem: string): string[] {
  return pem
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("-----") && line.length > 20);
}

describe("pemProblem", () => {
  it("accepts PKCS#1 and PKCS#8 RSA keys", () => {
    expect(pemProblem(rsaPem("pkcs1"))).toBeNull();
    expect(pemProblem(rsaPem("pkcs8"))).toBeNull();
  });

  it("rejects an encrypted key", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(pemProblem(privateKey)).toMatch(/encrypted/);
  });

  it("rejects an EC key", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(pemProblem(privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toMatch(
      /not an RSA/,
    );
  });

  it.each(["", "garbage", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"])(
    "rejects %j",
    (text) => {
      expect(pemProblem(text)).not.toBeNull();
    },
  );

  it("rejects a public key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(pemProblem(publicKey.export({ type: "spki", format: "pem" }).toString())).not.toBeNull();
  });

  it("never includes key material", () => {
    const pem = rsaPem("pkcs8");
    const corrupted = pem.replace(/(\n[A-Za-z0-9+/]{20})[A-Za-z0-9+/]/, "$1*");
    for (const text of [corrupted, pem.slice(0, -40), pem.replace("PRIVATE", "SECRET")]) {
      const problem = pemProblem(text);
      expect(problem).not.toBeNull();
      for (const line of body(pem)) expect(problem).not.toContain(line.slice(0, 16));
    }
  });
});

describe("normalizePem", () => {
  it("turns \\n escapes into newlines and trims", () => {
    const pem = rsaPem();
    expect(normalizePem(`  ${pem.trim().replace(/\n/g, "\\n")}  `)).toBe(pem.trim());
  });
});

describe("createAppJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  it("builds an RS256 JWT that verifies with the public key", () => {
    const now = 1_800_000_000;
    const jwt = createAppJwt(123456, pem, now);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ iat: now - 60, exp: now + 540, iss: "123456" });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("uses the clock by default", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = decode(createAppJwt("1", pem).split(".")[1] as string);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.exp - payload.iat).toBe(600);
  });

  it("fails for a bad key without key material in the message", () => {
    const bad = pem.replace(/(\n[A-Za-z0-9+/]{20})[A-Za-z0-9+/]/, "$1*");
    for (const key of [bad, "garbage", "", rsaPem().slice(0, 100)]) {
      let message = "";
      try {
        createAppJwt(1, key);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      for (const line of body(pem)) expect(message).not.toContain(line.slice(0, 16));
      expect(message).not.toContain("garbage");
    }
  });
});
