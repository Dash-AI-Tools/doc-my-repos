import { describe, expect, it } from "vitest";

import {
  RESERVED_OWNERS,
  apiReferenceUrl,
  apiSpecPathFromSegments,
  isReservedOwner,
  mayBePublicPath,
  repoUrl,
} from "./routes";

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

describe("mayBePublicPath", () => {
  it("lets the readable pages through for reads only", () => {
    for (const path of [
      "/",
      "/search",
      "/ask",
      "/acme/handbook",
      "/acme/handbook/docs/guides/setup",
    ]) {
      expect(mayBePublicPath(path, "GET"), path).toBe(true);
      expect(mayBePublicPath(path, "HEAD"), path).toBe(true);
      expect(mayBePublicPath(path, "POST"), path).toBe(false);
      expect(mayBePublicPath(path, "DELETE"), path).toBe(false);
    }
  });

  it("lets the three public APIs through, each for its own method", () => {
    expect(mayBePublicPath("/api/search", "GET")).toBe(true);
    expect(mayBePublicPath("/api/search", "POST")).toBe(false);
    expect(mayBePublicPath("/api/asset/acme/handbook/img.png", "GET")).toBe(true);
    expect(mayBePublicPath("/api/asset/acme/handbook/img.png", "PUT")).toBe(false);
    expect(mayBePublicPath("/api/ask", "POST")).toBe(true);
    expect(mayBePublicPath("/api/ask", "GET")).toBe(false);
  });

  it("keeps the cookie gate on every other path", () => {
    for (const path of [
      "/admin",
      "/admin/users",
      "/admin/workspace",
      "/account/agent-access",
      "/status",
      "/api/status",
      "/api/comments",
      "/api/admin/repos",
      "/api/account/tokens",
      "/api/plugins/billing/usage",
      "/-/billing/account",
      "/e2e/theme",
      "/api/nothing",
      "/login",
      "/search/x",
      "/_next/data/x",
      "/acme",
      "/acme/",
    ]) {
      expect(mayBePublicPath(path, "GET"), path).toBe(false);
    }
  });

  it("treats the app's own first segments as pages, case-insensitively", () => {
    for (const owner of ["admin", "ADMIN", "Account", "login", "api", "Status", "-"]) {
      expect(mayBePublicPath(`/${owner}/something`, "GET"), owner).toBe(false);
    }
    expect(mayBePublicPath("/Acme/Handbook", "GET")).toBe(true);
  });

  it("is case-insensitive about the method and refuses a path that is not absolute", () => {
    expect(mayBePublicPath("/", "get")).toBe(true);
    expect(mayBePublicPath("acme/handbook", "GET")).toBe(false);
  });
});
