import { describe, expect, it } from "vitest";

import { repoUrl } from "@/lib/routes";

describe("repoUrl", () => {
  it("builds /<owner>/<repo>", () => {
    expect(repoUrl("acme", "api-service")).toBe("/acme/api-service");
  });

  it("percent-encodes each segment so a name cannot change the path", () => {
    expect(repoUrl("a/b", "c d?#")).toBe("/a%2Fb/c%20d%3F%23");
  });
});
