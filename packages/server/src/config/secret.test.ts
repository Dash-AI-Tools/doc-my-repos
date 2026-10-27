import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { Secret } from "./secret";

const VALUE = "SENTINEL_SECRET_VALUE_8c1d";

describe("Secret", () => {
  it("reveals the value only through reveal()", () => {
    expect(new Secret(VALUE).reveal()).toBe(VALUE);
  });

  it("redacts the value in JSON, strings and inspection", () => {
    const secret = new Secret(VALUE);
    const holder = { secret, nested: { list: [secret] } };
    const renderings = [
      JSON.stringify(holder),
      String(secret),
      `${secret}`,
      secret + "",
      inspect(holder, { depth: Infinity, showHidden: true }),
      inspect(secret, { customInspect: false, showHidden: true }),
      Object.keys(secret).join(","),
    ];
    for (const text of renderings) expect(text).not.toContain(VALUE);
    expect(JSON.stringify(holder)).toContain("[redacted]");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(new Secret(VALUE))).toBe(true);
  });
});
