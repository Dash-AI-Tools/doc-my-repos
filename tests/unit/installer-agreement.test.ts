// The installer (packages/create-docmyrepos) re-implements the app's startup checks so it imports
// nothing from src/. This test imports both and proves they accept and reject the same values.
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { pemProblem as installerPemProblem } from "../../packages/create-docmyrepos/src/pem";
import {
  validateEmail,
  validateNumericId,
  validatePassword,
  validateSharedSecret,
} from "../../packages/create-docmyrepos/src/validate";
import { parseEnv, pemProblem as appPemProblem } from "@/server/config/env";

const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

/** A complete valid environment; each test varies one variable. */
const VALID_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://u:p@db:5432/d",
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY: KEY.trim().replace(/\n/g, "\\n"),
  GITHUB_WEBHOOK_SECRET: "w".repeat(32),
  SYNC_SECRET: "s".repeat(32),
  SESSION_SECRET: "t".repeat(32),
};

/** Whether the app reports a problem for `name` when it is set to `value`. */
function appRejects(name: string, value: string, extra: Record<string, string> = {}): boolean {
  const result = parseEnv({ ...VALID_ENV, ...extra, [name]: value }, () => {
    throw new Error("no files");
  });
  return result.problems.some((problem) => problem.startsWith(`${name}:`));
}

// Fixtures use non-blank values: the app treats a blank as "not set", which the installer reports
// as a missing answer instead.
const IDS = [
  "1",
  "42",
  "123456789",
  "9007199254740991",
  "9007199254740992",
  "0",
  "-1",
  "01",
  "1.5",
  "1e3",
  "abc",
  "12 3",
  "+5",
  " 7 ",
  "٣",
];
const SECRETS = [
  "x".repeat(15),
  "x".repeat(16),
  "x".repeat(64),
  "  " + "x".repeat(16) + "  ",
  " " + "x".repeat(15) + " ",
  "replace-with-a-long-random-value",
  "REPLACE-WITH-something-else-long",
  "replace-with-",
  "xreplace-with-long-enough-secret",
  "pässwörd-with-ünïcode-1234",
  "a b c d e f g h i j k l m n o p",
];
const EMAILS = [
  "admin@example.com",
  "a.b+c@sub.example.org",
  "admin@",
  "@example.com",
  "admin",
  "admin@example",
  "a b@example.com",
  "a@b.c",
  "a..b@example.com",
  ".a@example.com",
  "a@-example.com",
  "a@example..com",
  "user@localhost",
  "user@exa_mple.com",
  "ünï@example.com",
  "a@b.co",
  "  admin@example.com  ",
];
const PASSWORDS = [
  "abcdefghijk",
  "abcdefghijkl",
  "x".repeat(40),
  "short",
  "a".repeat(11) + "é",
  "1234567890 1",
];

describe("installer validators agree with src/server/config/env.ts", () => {
  it.each(IDS)("GITHUB_APP_ID / INSTALLATION_ID %j", (value) => {
    const installer = validateNumericId(value).ok;
    expect(!appRejects("GITHUB_APP_ID", value)).toBe(installer);
    expect(!appRejects("GITHUB_APP_INSTALLATION_ID", value)).toBe(installer);
  });

  it.each(SECRETS)("shared secrets %j", (value) => {
    const installer = validateSharedSecret(value).ok;
    for (const name of ["GITHUB_WEBHOOK_SECRET", "SYNC_SECRET", "SESSION_SECRET"]) {
      expect(!appRejects(name, value)).toBe(installer);
    }
  });

  it.each(EMAILS)("ADMIN_EMAIL %j", (value) => {
    expect(!appRejects("ADMIN_EMAIL", value, { ADMIN_PASSWORD: "p".repeat(12) })).toBe(
      validateEmail(value).ok,
    );
  });

  it.each(PASSWORDS)("ADMIN_PASSWORD %j", (value) => {
    // The installer is stricter in two ways the app is not (quotes, edge whitespace), so only
    // check it never accepts what the app rejects, and equals it for plain values.
    const installer = validatePassword(value).ok;
    const app = !appRejects("ADMIN_PASSWORD", value, { ADMIN_EMAIL: "a@example.com" });
    if (installer) expect(app).toBe(true);
    expect(installer).toBe(app);
  });

  it("the installer's extra password rules are only stricter", () => {
    for (const value of [" " + "a".repeat(12), "a".repeat(12) + " ", "a'b" + "c".repeat(10)]) {
      expect(validatePassword(value).ok).toBe(false);
    }
  });

  it("PEM acceptance matches pemProblem", () => {
    const pkcs8 = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const encrypted = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    const corrupted = KEY.replace(/(\n[A-Za-z0-9+/]{20})[A-Za-z0-9+/]/, "$1*");
    const samples = [
      KEY,
      KEY.trim(),
      pkcs8,
      encrypted,
      ec,
      publicKey,
      corrupted,
      KEY.slice(0, 200),
      "",
      "garbage",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      KEY.replace(/RSA PRIVATE KEY/g, "OPENSSH PRIVATE KEY"),
    ];
    for (const sample of samples) {
      const trimmed = sample.trim();
      expect(installerPemProblem(trimmed) === null).toBe(appPemProblem(trimmed) === null);
      // Same wording, so the user sees the same explanation either way.
      expect(installerPemProblem(trimmed)).toBe(appPemProblem(trimmed));
    }
  });
});
