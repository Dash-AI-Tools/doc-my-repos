import { describe, expect, it } from "vitest";

import { joinClassNames } from "@/lib/utils";

describe("joinClassNames", () => {
  it("joins the truthy class fragments with single spaces", () => {
    expect(joinClassNames("px-2", "py-1", "font-bold")).toBe("px-2 py-1 font-bold");
  });

  it("drops false, null, undefined and empty fragments", () => {
    expect(joinClassNames("px-2", false, null, undefined, "", "dark:bg-black")).toBe(
      "px-2 dark:bg-black",
    );
  });

  it("returns an empty string when nothing is left", () => {
    expect(joinClassNames()).toBe("");
    expect(joinClassNames(false, null, undefined)).toBe("");
  });
});
