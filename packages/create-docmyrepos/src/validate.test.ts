import { describe, expect, it } from "vitest";

import {
  parseRepositoryList,
  validateAddress,
  validateEmail,
  validateImageTag,
  validateNumericId,
  validateOrganization,
  validatePassword,
  validatePort,
  validateRepositoryName,
  validateRepositoryNames,
  validateSharedSecret,
} from "./validate.js";

const accepted = <T>(check: { ok: boolean; value?: T }) => check.ok;

describe("validateOrganization", () => {
  it.each(["acme", "Acme-Corp", "a", "a1-b2", "x".repeat(39)])("accepts %s", (v) => {
    expect(accepted(validateOrganization(v))).toBe(true);
  });
  it.each(["", "  ", "-acme", "acme-", "ac--me", "ac me", "ac_me", "acme.io", "x".repeat(40), "é"])(
    "rejects %j",
    (v) => {
      expect(validateOrganization(v).ok).toBe(false);
    },
  );
  it("trims", () => {
    expect(validateOrganization("  acme ")).toEqual({ ok: true, value: "acme" });
  });
});

describe("validateAddress", () => {
  it.each([
    ["http://localhost:3000", "http://localhost:3000", true],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000", true],
    ["http://[::1]:3000", "http://[::1]:3000", true],
    ["http://docs.localhost", "http://docs.localhost", true],
    ["https://docs.example.com", "https://docs.example.com", false],
    ["https://docs.example.com:8443/", "https://docs.example.com:8443", false],
  ])("accepts %s", (input, url, loopback) => {
    const result = validateAddress(input);
    expect(result.ok && result.value.url).toBe(url);
    expect(result.ok && result.value.loopback).toBe(loopback);
  });

  it("warns about TLS for a public address only", () => {
    const pub = validateAddress("https://docs.example.com");
    const local = validateAddress("http://localhost:3000");
    expect(pub.ok && pub.value.warning).toMatch(/TLS/);
    expect(local.ok && local.value.warning).toBeUndefined();
  });

  it.each([
    "",
    "docs.example.com",
    "ftp://docs.example.com",
    "http://docs.example.com",
    "http://127.0.0.1.example.com",
    "http://10.0.0.5:3000",
    "https://user:pw@docs.example.com",
    "https://docs.example.com/path",
    "https://docs.example.com/?q=1",
    "https://docs.example.com/#x",
    "javascript:alert(1)",
  ])("rejects %j", (input) => {
    expect(validateAddress(input).ok).toBe(false);
  });

  it("explains that a public address needs https", () => {
    const result = validateAddress("http://docs.example.com");
    expect(!result.ok && result.reason).toMatch(/https/);
  });
});

describe("validatePort", () => {
  it.each([
    ["1", 1],
    ["3000", 3000],
    ["65535", 65535],
    [8080, 8080],
    [" 80 ", 80],
  ])("accepts %j", (input, port) => {
    expect(validatePort(input)).toEqual({ ok: true, value: port });
  });
  it.each(["", "0", "65536", "-1", "3.5", "abc", "99999", "1e3", 0, 70000])("rejects %j", (v) => {
    expect(validatePort(v).ok).toBe(false);
  });
});

describe("validateEmail", () => {
  it.each(["admin@example.com", "a.b+c@sub.example.org", " admin@example.com "])(
    "accepts %j",
    (v) => {
      expect(validateEmail(v).ok).toBe(true);
    },
  );
  it.each(["", "admin@", "@example.com", "admin", "admin@example", "a b@example.com", "a@b.c"])(
    "rejects %j",
    (v) => {
      expect(validateEmail(v).ok).toBe(false);
    },
  );
});

describe("validatePassword", () => {
  it("accepts 12 characters", () => {
    expect(validatePassword("abcdefghijkl").ok).toBe(true);
  });
  it("rejects 11 characters, naming the rule but not the value", () => {
    const result = validatePassword("abcdefghijk");
    expect(!result.ok && result.reason).toMatch(/12/);
    expect(!result.ok && result.reason).not.toContain("abcdefghijk");
  });
  it.each([" abcdefghijkl", "abcdefghijkl ", "abcdefghi'jkl", "abcdefghi\njkl", "x".repeat(129)])(
    "rejects %j",
    (v) => {
      expect(validatePassword(v).ok).toBe(false);
    },
  );
});

describe("repository names", () => {
  it.each(["api", "my.repo_1-x", "a".repeat(100)])("accepts %s", (v) => {
    expect(validateRepositoryName(v).ok).toBe(true);
  });
  it.each(["", "owner/repo", "a b", ".", "..", "a".repeat(101), "r*"])("rejects %j", (v) => {
    expect(validateRepositoryName(v).ok).toBe(false);
  });
  it("rejects an empty list and duplicates", () => {
    expect(validateRepositoryNames([]).ok).toBe(false);
    expect(validateRepositoryNames(["a", "b", "a"]).ok).toBe(false);
    expect(validateRepositoryNames(["a", "b"])).toEqual({ ok: true, value: ["a", "b"] });
  });
  it("parses --repos lists", () => {
    expect(parseRepositoryList("a, b,c")).toEqual({ ok: true, value: ["a", "b", "c"] });
    expect(parseRepositoryList("a,,b").ok).toBe(false);
  });
});

describe("validateSharedSecret", () => {
  it("accepts 16 characters, rejects 15, blanks and placeholders", () => {
    expect(validateSharedSecret("x".repeat(16)).ok).toBe(true);
    expect(validateSharedSecret("x".repeat(15)).ok).toBe(false);
    expect(validateSharedSecret("   ").ok).toBe(false);
    expect(validateSharedSecret("replace-with-a-long-random-value").ok).toBe(false);
    expect(validateSharedSecret("REPLACE-WITH-a-long-random-value").ok).toBe(false);
  });
});

describe("validateNumericId / validateImageTag", () => {
  it("ids", () => {
    expect(validateNumericId("12345")).toEqual({ ok: true, value: 12345 });
    for (const v of ["", "0", "-1", "01", "1.5", "abc", "9".repeat(20)]) {
      expect(validateNumericId(v).ok).toBe(false);
    }
  });
  it("tags", () => {
    for (const v of ["1.2.0", "next", "v1_2-3", "0.1.0-rc.1"])
      expect(validateImageTag(v).ok).toBe(true);
    for (const v of ["", "-x", ".x", "a b", "a:b", "a/b", "x".repeat(129)]) {
      expect(validateImageTag(v).ok).toBe(false);
    }
  });
});
