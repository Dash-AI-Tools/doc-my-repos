import { describe, expect, it } from "vitest";

import { e2eFixturesEnabled } from "./e2e-fixtures";

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
