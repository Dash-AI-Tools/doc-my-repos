import { describe, expect, it } from "vitest";

import { publicAccessStatusLine } from "./public-access-status";

describe("publicAccessStatusLine", () => {
  it("is off while nothing is public, whatever the switches say", () => {
    expect(
      publicAccessStatusLine({ anyPublic: false, searchEnabled: true, askEnabled: true }),
    ).toEqual({
      tone: "neutral",
      label: "Off",
      detail: "Nothing is public. Visitors must sign in to read anything.",
    });
  });

  it("names what anonymous visitors may do once something is public", () => {
    const line = (searchEnabled: boolean, askEnabled: boolean) =>
      publicAccessStatusLine({ anyPublic: true, searchEnabled, askEnabled });
    expect(line(true, true)).toMatchObject({ tone: "good", label: "On" });
    expect(line(true, true).detail).toContain("search and use Ask");
    expect(line(true, false).detail).toContain("and search.");
    expect(line(false, true).detail).toContain("and use Ask.");
    expect(line(false, false).detail).toContain("but not search or use Ask");
  });
});
