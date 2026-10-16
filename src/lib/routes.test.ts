import { describe, expect, it } from "vitest";

import {
  RESERVED_OWNERS,
  apiReferenceUrl,
  apiSpecPathFromSegments,
  isReservedOwner,
  repoUrl,
} from "@/lib/routes";

describe("repoUrl", () => {
  it("builds /<owner>/<repo>", () => {
    expect(repoUrl("acme", "api-service")).toBe("/acme/api-service");
  });

  it("percent-encodes each segment so a name cannot change the path", () => {
    expect(repoUrl("a/b", "c d?#")).toBe("/a%2Fb/c%20d%3F%23");
  });
});

describe("isReservedOwner", () => {
  it("reserves the segments the app owns, in any case", () => {
    for (const name of ["api", "API", "search", "Search", "e2e", "_next", "favicon.ico"]) {
      expect(isReservedOwner(name), name).toBe(true);
    }
  });

  it("does not reserve ordinary owners", () => {
    for (const name of ["acme", "searcher", "api-team", "docs"]) {
      expect(isReservedOwner(name), name).toBe(false);
    }
  });

  it("holds only lower-case names (lookups lower-case the input)", () => {
    for (const name of RESERVED_OWNERS) expect(name).toBe(name.toLowerCase());
  });
});

describe("apiReferenceUrl", () => {
  it("builds /<owner>/<repo>/api-reference/<path> and encodes each segment", () => {
    expect(apiReferenceUrl("acme", "svc", "api/openapi.yaml")).toBe(
      "/acme/svc/api-reference/api/openapi.yaml",
    );
    expect(apiReferenceUrl("a", "b", "x y/#z.json")).toBe("/a/b/api-reference/x%20y/%23z.json");
  });

  it("refuses paths with empty, dot or dot-dot segments", () => {
    for (const p of ["", "a//b", "../a", "a/./b", "a/.."]) {
      expect(apiReferenceUrl("a", "b", p), p).toBeNull();
    }
  });
});

describe("apiSpecPathFromSegments", () => {
  it("joins plain segments and refuses anything else", () => {
    expect(apiSpecPathFromSegments(["api", "openapi.yaml"])).toBe("api/openapi.yaml");
    for (const segs of [[], [""], [".."], ["a/b"], ["a\\b"], ["a\u0000"]]) {
      expect(apiSpecPathFromSegments(segs), JSON.stringify(segs)).toBeNull();
    }
  });
});
