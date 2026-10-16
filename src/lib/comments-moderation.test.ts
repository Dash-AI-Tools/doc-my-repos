import { describe, expect, it } from "vitest";

import { commentCount, excerptOf, moderationHref } from "./comments-moderation";

describe("excerptOf", () => {
  it("folds whitespace and keeps short text whole", () => {
    expect(excerptOf("  one\n\ntwo\t three ")).toBe("one two three");
  });
  it("cuts at 200 code points with an ellipsis", () => {
    const out = excerptOf("a".repeat(500));
    expect(Array.from(out)).toHaveLength(201);
    expect(out.endsWith("…")).toBe(true);
    expect(excerptOf("a".repeat(200))).toBe("a".repeat(200));
  });
  it("never splits a surrogate pair", () => {
    const out = excerptOf("😀".repeat(300));
    expect(Array.from(out)).toHaveLength(201);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("moderationHref", () => {
  it("builds the address from the filters and extras", () => {
    expect(moderationHref({})).toBe("/admin/comments");
    expect(
      moderationHref({ state: "orphaned", githubRepoId: 7 }, { removed: 3, deleted: null }),
    ).toBe("/admin/comments?state=orphaned&repo=7&removed=3");
    expect(moderationHref({ cursor: "2026-01-01T00:00:00.000000+00|5" })).toContain("cursor=");
  });
  it("counts comments", () => {
    expect(commentCount(1)).toBe("1 comment");
    expect(commentCount(1200)).toBe("1,200 comments");
  });
});
