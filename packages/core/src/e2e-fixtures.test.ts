import { describe, expect, it } from "vitest";

import { e2eFixturesEnabled, E2E_CRASH_HEADER, shouldCrashRootLayout } from "./e2e-fixtures";

describe("e2eFixturesEnabled", () => {
  it("is on only for the exact value 1", () => {
    expect(e2eFixturesEnabled({ E2E_FIXTURES: "1" })).toBe(true);
  });

  it.each([undefined, "", "0", "true", "yes", " 1", "1 ", "11"])("is off for %j", (value) => {
    expect(e2eFixturesEnabled({ E2E_FIXTURES: value })).toBe(false);
  });

  it("is off when the variable is missing", () => {
    expect(e2eFixturesEnabled({})).toBe(false);
  });
});

describe("shouldCrashRootLayout", () => {
  it("needs both the fixtures switch and the exact header value", () => {
    expect(E2E_CRASH_HEADER).toBe("x-e2e-crash-layout");
    expect(shouldCrashRootLayout({ E2E_FIXTURES: "1" }, "1")).toBe(true);
  });

  it("never crashes a server without E2E_FIXTURES, whatever the request says", () => {
    for (const env of [{}, { E2E_FIXTURES: "" }, { E2E_FIXTURES: "0" }, { E2E_FIXTURES: "true" }]) {
      expect(shouldCrashRootLayout(env, "1")).toBe(false);
    }
  });

  it("ignores a missing or different header value", () => {
    for (const value of [null, "", "0", "true", " 1", "11"]) {
      expect(shouldCrashRootLayout({ E2E_FIXTURES: "1" }, value)).toBe(false);
    }
  });
});
