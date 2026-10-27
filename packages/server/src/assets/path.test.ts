import { describe, expect, it } from "vitest";

import { assetUrl } from "@docmyrepos/core/internal/routes";
import {
  isSafeAssetPath,
  isSafeAssetSegment,
  MAX_ASSET_PATH_CHARS,
  parseAssetTarget,
  rawAssetSegments,
} from "./path";

/** Splits a raw URL path tail the way the route does. */
const raw = (tail: string) => tail.split("/");

describe("parseAssetTarget", () => {
  it("decodes each segment exactly once", () => {
    expect(parseAssetTarget(raw("acme/handbook/docs/img/my%20diagram.png"))).toEqual({
      owner: "acme",
      repo: "handbook",
      path: "docs/img/my diagram.png",
    });
    expect(parseAssetTarget(raw("acme/handbook/%C3%A9t%C3%A9.png"))?.path).toBe("été.png");
    expect(parseAssetTarget(raw("Acme/Hand.book/.github/logo.png"))).toEqual({
      owner: "Acme",
      repo: "Hand.book",
      path: ".github/logo.png",
    });
  });

  it("round-trips assetUrl", () => {
    const url = assetUrl("acme", "handbook", "docs/a b/#1?.png");
    expect(url).toBe("/api/asset/acme/handbook/docs/a%20b/%231%3F.png");
    const segments = rawAssetSegments(url ?? "");
    expect(segments && parseAssetTarget(segments)?.path).toBe("docs/a b/#1?.png");
  });

  // Every entry is the raw URL path after /api/asset/, as it would arrive.
  const traversal: [string, string][] = [
    ["parent segment", "acme/handbook/../secret.png"],
    ["parent at start", "acme/handbook/../../etc/passwd.png"],
    ["dot segment", "acme/handbook/./a.png"],
    ["encoded parent lower", "acme/handbook/%2e%2e/a.png"],
    ["encoded parent upper", "acme/handbook/%2E%2E/a.png"],
    ["encoded parent and slash", "acme/handbook/%2E%2E%2Fsecret.png"],
    ["encoded slash", "acme/handbook/docs%2fa.png"],
    ["encoded slash upper", "acme/handbook/docs%2Fa.png"],
    ["half-encoded parent", "acme/handbook/.%2e/a.png"],
    ["double-encoded parent", "acme/handbook/%252e%252e/a.png"],
    ["double-encoded slash", "acme/handbook/a%252fb.png"],
    ["double-encoded name", "acme/handbook/a%2520b.png"],
    ["backslash", "acme/handbook/docs\\a.png"],
    ["encoded backslash", "acme/handbook/..%5ca.png"],
    ["encoded backslash upper", "acme/handbook/docs%5Ca.png"],
    ["NUL", "acme/handbook/a%00.png"],
    ["raw NUL", "acme/handbook/a\u0000.png"],
    ["newline", "acme/handbook/a%0a.png"],
    ["DEL", "acme/handbook/a%7f.png"],
    ["C1 control", "acme/handbook/a%c2%85.png"],
    ["line separator", "acme/handbook/a%e2%80%a8.png"],
    ["bidi override", "acme/handbook/a%e2%80%aegnp.svg"],
    ["fullwidth dots", "acme/handbook/%ef%bc%8e%ef%bc%8e/a.png"],
    ["two-dot leader", "acme/handbook/%e2%80%a5/a.png"],
    ["one-dot leaders", "acme/handbook/%e2%80%a4%e2%80%a4/a.png"],
    ["fullwidth solidus", "acme/handbook/..%ef%bc%8fa.png"],
    ["triple dots", "acme/handbook/.../a.png"],
    ["empty segment", "acme/handbook//a.png"],
    ["leading slash (absolute)", "acme/handbook//etc/a.png"],
    ["trailing slash", "acme/handbook/img/"],
    ["only a slash", "acme/handbook/"],
    [".git folder", "acme/handbook/.git/config"],
    [".git any case", "acme/handbook/.GIT/logo.png"],
    ["node_modules climb", "acme/handbook/node_modules/../a.png"],
    ["malformed escape", "acme/handbook/a%zz.png"],
    ["lone surrogate", "acme/handbook/a%ed%a0%80.png"],
    ["bad owner", "ac%2fme/handbook/a.png"],
    ["owner traversal", "../handbook/a.png"],
    ["repo traversal", "acme/../a.png"],
    ["repo dot", "acme/./a.png"],
    ["encoded repo traversal", "acme/%2e%2e/a.png"],
    ["owner with dot", "ac.me/handbook/a.png"],
    ["missing path", "acme/handbook"],
    ["empty owner", "/handbook/a.png"],
  ];

  it.each(traversal)("refuses %s", (_name, tail) => {
    expect(parseAssetTarget(raw(tail))).toBeNull();
  });

  it("refuses an over-long path and too many segments", () => {
    const long = "a".repeat(MAX_ASSET_PATH_CHARS) + ".png";
    expect(parseAssetTarget(raw(`acme/handbook/${long}`))).toBeNull();
    const deep = Array.from({ length: 70 }, () => "d").join("/");
    expect(parseAssetTarget(raw(`acme/handbook/${deep}/a.png`))).toBeNull();
    // A raw URL far longer than any valid one is refused before decoding.
    expect(parseAssetTarget(raw(`acme/handbook/${"%41".repeat(5000)}.png`))).toBeNull();
  });

  it("accepts a path at the length limit", () => {
    const name = "a".repeat(MAX_ASSET_PATH_CHARS - 4) + ".png";
    expect(parseAssetTarget(raw(`acme/handbook/${name}`))?.path).toBe(name);
  });
});

describe("segment and path rules", () => {
  it.each(["a.png", ".github", "img", "my diagram.png", "été", "a..b.png", "..a.png", "a.."])(
    "accepts %j",
    (segment) => {
      expect(isSafeAssetSegment(segment)).toBe(true);
    },
  );

  it.each(["", ".", "..", "...", ".git", "a/b", "a\\b", "a\u0000", "%2e", "a%20b", "‥"])(
    "refuses %j",
    (segment) => {
      expect(isSafeAssetSegment(segment)).toBe(false);
    },
  );

  it("checks whole paths", () => {
    expect(isSafeAssetPath("docs/img/a.png")).toBe(true);
    expect(isSafeAssetPath("")).toBe(false);
    expect(isSafeAssetPath("docs//a.png")).toBe(false);
    expect(isSafeAssetPath("/docs/a.png")).toBe(false);
  });
});

describe("rawAssetSegments", () => {
  it("takes the segments after the route prefix, still encoded", () => {
    expect(rawAssetSegments("/api/asset/acme/r/a%20b.png")).toEqual(["acme", "r", "a%20b.png"]);
    expect(rawAssetSegments("/api/assets/acme/r/a.png")).toBeNull();
    expect(rawAssetSegments("/other")).toBeNull();
  });
});
