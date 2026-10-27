import { describe, expect, it, vi } from "vitest";

import { verifySyncSecret } from "./auth";

const SECRET = "SENTINEL-sync-secret-4f9a1c7e";

describe("verifySyncSecret", () => {
  it("accepts the exact secret as a bearer token", () => {
    expect(verifySyncSecret(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("accepts any case of the scheme (RFC 9110) but nothing else about the shape", () => {
    expect(verifySyncSecret(`bearer ${SECRET}`, SECRET)).toBe(true);
    expect(verifySyncSecret(`BEARER ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifySyncSecret("Bearer SENTINEL-sync-secret-00000000", SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET.toUpperCase()}`, SECRET)).toBe(false);
  });

  it("rejects a prefix, a suffix and a different length of the secret", () => {
    expect(verifySyncSecret(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer x${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET}${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret("Bearer a", SECRET)).toBe(false);
  });

  it("rejects missing, empty and blank headers", () => {
    expect(verifySyncSecret(null, SECRET)).toBe(false);
    expect(verifySyncSecret(undefined, SECRET)).toBe(false);
    expect(verifySyncSecret("", SECRET)).toBe(false);
    expect(verifySyncSecret("   ", SECRET)).toBe(false);
    expect(verifySyncSecret("Bearer", SECRET)).toBe(false);
    expect(verifySyncSecret("Bearer ", SECRET)).toBe(false);
  });

  it("rejects other schemes and a bare secret", () => {
    expect(verifySyncSecret(SECRET, SECRET)).toBe(false);
    expect(verifySyncSecret(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Token ${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer: ${SECRET}`, SECRET)).toBe(false);
  });

  it("rejects extra whitespace around or inside the header", () => {
    expect(verifySyncSecret(`Bearer  ${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer\t${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret(` Bearer ${SECRET}`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET} `, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET}\n`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET} extra`, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET.slice(0, 5)} ${SECRET.slice(5)}`, SECRET)).toBe(false);
  });

  it("handles non-ASCII input without throwing or matching", () => {
    expect(verifySyncSecret("Bearer sécret-ключ-密码-🔑🔑🔑🔑", SECRET)).toBe(false);
    expect(verifySyncSecret("Bearer \u0000\u0001\u0002", SECRET)).toBe(false);
    // A non-ASCII secret compares by its UTF-8 bytes.
    const unicode = "ключ-密码-🔑-sync-secret";
    expect(verifySyncSecret(`Bearer ${unicode}`, unicode)).toBe(true);
    expect(verifySyncSecret(`Bearer ${unicode}x`, unicode)).toBe(false);
  });

  it("rejects a very long header without hashing it", () => {
    expect(verifySyncSecret(`Bearer ${"a".repeat(1_000_000)}`, SECRET)).toBe(false);
    const long = "s".repeat(5000);
    expect(verifySyncSecret(`Bearer ${long}`, long)).toBe(false);
  });

  it("never matches when the expected secret is empty or too short", () => {
    expect(verifySyncSecret("Bearer ", "")).toBe(false);
    expect(verifySyncSecret("Bearer x", "")).toBe(false);
    expect(verifySyncSecret(null, "")).toBe(false);
    expect(verifySyncSecret("Bearer short", "short")).toBe(false);
    expect(verifySyncSecret("Bearer fifteen-chars-x", "fifteen-chars-x".slice(0, 15))).toBe(false);
  });

  it("does not throw on non-string input", () => {
    expect(verifySyncSecret(42 as unknown as string, SECRET)).toBe(false);
    expect(verifySyncSecret({} as unknown as string, SECRET)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET}`, undefined as unknown as string)).toBe(false);
    expect(verifySyncSecret(`Bearer ${SECRET}`, null as unknown as string)).toBe(false);
  });

  it("logs nothing", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    verifySyncSecret(`Bearer ${SECRET}`, SECRET);
    verifySyncSecret("Bearer wrong-wrong-wrong-wrong", SECRET);
    verifySyncSecret(null, SECRET);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
