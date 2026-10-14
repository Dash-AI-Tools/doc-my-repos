import { describe, expect, it } from "vitest";

import { githubBlobUrl, githubRepoUrl, ownerKey, ownerLink, stripAt } from "./github-links";

describe("ownerLink", () => {
  it("links a user to the profile, without the @", () => {
    expect(ownerLink("@alice", "user")).toEqual({
      href: "https://github.com/alice",
      external: true,
    });
    expect(ownerLink("@Alice-Dev_1", "user")?.href).toBe("https://github.com/Alice-Dev_1");
  });

  it("links a team to the organization team page", () => {
    expect(ownerLink("@my-org/docs-team", "team")).toEqual({
      href: "https://github.com/orgs/my-org/teams/docs-team",
      external: true,
    });
    expect(ownerLink("@acme/team.core_1", "team")?.href).toBe(
      "https://github.com/orgs/acme/teams/team.core_1",
    );
  });

  it("links an e-mail owner with mailto, which is not external", () => {
    expect(ownerLink("security@acme.example", "email")).toEqual({
      href: "mailto:security@acme.example",
      external: false,
    });
  });

  it("returns null when the handle does not fit its kind", () => {
    expect(ownerLink("alice", "user")).toBeNull(); // no @: not what the sync stores
    expect(ownerLink("@alice", "team")).toBeNull();
    expect(ownerLink("@a/b", "user")).toBeNull();
    expect(ownerLink("@org/team", "email")).toBeNull();
    expect(ownerLink("@", "user")).toBeNull();
    expect(ownerLink("@org/", "team")).toBeNull();
    expect(ownerLink("@/team", "team")).toBeNull();
    expect(ownerLink("@org/a/b", "team")).toBeNull();
    expect(ownerLink("@org/..", "team")).toBeNull();
    expect(ownerLink("@alice", "other" as never)).toBeNull();
    expect(ownerLink(undefined as never, "user")).toBeNull();
  });

  it("never builds a link from a hostile handle", () => {
    const hostile: [string, "user" | "team" | "email"][] = [
      ["@javascript:alert(1)", "user"],
      ["@alice/../../evil", "user"],
      ["@alice?x=1", "user"],
      ["@alice#x", "user"],
      ["@alice%2f..", "user"],
      ["@alice\nHost: evil", "user"],
      ["@ali ce", "user"],
      ['@"><img src=x onerror=alert(1)>', "user"],
      ["@a".padEnd(41, "a"), "user"],
      ["@org/team?x=1", "team"],
      ["@org/team#frag", "team"],
      ["@org/te%2fam", "team"],
      ["@org/<script>", "team"],
      ["@org\\team", "team"],
      ["@evil.com/team", "team"],
      ["a@b.co?bcc=x@evil.example", "email"],
      ["a@b.co&bcc=x@evil.example", "email"],
      ["a@b.co,x@evil.example", "email"],
      ["a@b.co;x@evil.example", "email"],
      ["a%0d%0abcc:x@b.co", "email"],
      ['"a b"@example.com', "email"],
      ["<a@example.com>", "email"],
      ["a@example", "email"],
      ["javascript:alert(1)//@example.com", "email"],
      ["a@b.co\n", "email"],
    ];
    for (const [handle, kind] of hostile) {
      expect(ownerLink(handle, kind), `${kind}: ${JSON.stringify(handle)}`).toBeNull();
    }
  });

  it("only ever returns https://github.com or mailto: URLs", () => {
    for (const [handle, kind] of [
      ["@alice", "user"],
      ["@o/t", "team"],
      ["a@b.co", "email"],
    ] as const) {
      expect(ownerLink(handle, kind)?.href).toMatch(/^(https:\/\/github\.com\/|mailto:)/);
    }
  });
});

describe("handle helpers", () => {
  it("strips one leading @", () => {
    expect(stripAt("@alice")).toBe("alice");
    expect(stripAt("a@b.co")).toBe("a@b.co");
    expect(stripAt("@@x")).toBe("@x");
  });

  it("folds case for grouping", () => {
    expect(ownerKey("@Acme/Docs")).toBe(ownerKey("@acme/docs"));
  });
});

describe("githubRepoUrl", () => {
  it("uses the reported https URL", () => {
    expect(githubRepoUrl("https://github.com/acme/api", "acme", "api")).toBe(
      "https://github.com/acme/api",
    );
    expect(githubRepoUrl("https://ghe.example.com/acme/api", "acme", "api")).toBe(
      "https://ghe.example.com/acme/api",
    );
  });

  it("builds the github.com URL when the stored one is not a plain https URL", () => {
    const fallback = "https://github.com/acme/api";
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/acme/api",
      "https://user:pw@github.com/acme/api",
      "data:text/html,<script>",
      "not a url",
      "",
      null,
      undefined,
      `https://github.com/${"a".repeat(3000)}`,
    ]) {
      expect(githubRepoUrl(bad, "acme", "api")).toBe(fallback);
    }
  });

  it("encodes the owner and name in the fallback", () => {
    expect(githubRepoUrl(null, "a/b", "c d?")).toBe("https://github.com/a%2Fb/c%20d%3F");
  });
});

describe("githubBlobUrl", () => {
  const url = (path: string, branch: string | null = "main", htmlUrl: string | null = null) =>
    githubBlobUrl(htmlUrl, "acme", "api", branch, path);

  it("links a file on the default branch", () => {
    expect(url("docs/guides/setup.md")).toBe(
      "https://github.com/acme/api/blob/main/docs/guides/setup.md",
    );
  });

  it("encodes every segment, so a file name cannot start a fragment or a query", () => {
    expect(url("docs/100% done #1?.md")).toBe(
      "https://github.com/acme/api/blob/main/docs/100%25%20done%20%231%3F.md",
    );
    expect(url("docs/a\\b.md")).toBe("https://github.com/acme/api/blob/main/docs/a%5Cb.md");
    expect(url("docs/ü/é.md")).toBe("https://github.com/acme/api/blob/main/docs/%C3%BC/%C3%A9.md");
  });

  it("keeps the slashes of a branch name and encodes the rest", () => {
    expect(url("docs/a.md", "feature/new docs")).toBe(
      "https://github.com/acme/api/blob/feature/new%20docs/docs/a.md",
    );
  });

  it("uses HEAD for an empty branch", () => {
    expect(url("docs/a.md", "")).toBe("https://github.com/acme/api/blob/HEAD/docs/a.md");
    expect(url("docs/a.md", null)).toBe("https://github.com/acme/api/blob/HEAD/docs/a.md");
  });

  it("refuses paths that would be normalized away or are not text", () => {
    for (const bad of [
      "",
      "../secrets.md",
      "docs/../../x.md",
      "docs/./a.md",
      "/docs/a.md",
      "docs//a.md",
      "docs/a.md/",
      "docs/a\u0000.md",
      "docs/a\nb.md",
      "docs/\u007f.md",
      `docs/${"a".repeat(2100)}.md`,
    ]) {
      expect(url(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(url("docs/a.md", "../main")).toBeNull();
    expect(url("docs/a.md", "main\n")).toBeNull();
  });

  it("never lets path text change the host or the scheme", () => {
    const out = url("javascript:alert(1).md") ?? "";
    expect(out.startsWith("https://github.com/acme/api/blob/main/")).toBe(true);
    expect(out).toContain("javascript%3Aalert(1)");
    expect(new URL(out).host).toBe("github.com");
    const other = url("@evil.example/x.md") ?? "";
    expect(new URL(other).host).toBe("github.com");
  });

  it("takes only the origin from a reported https URL (GitHub Enterprise), never its path", () => {
    expect(url("docs/a.md", "main", "https://ghe.example.com/other/path?x=1#y")).toBe(
      "https://ghe.example.com/acme/api/blob/main/docs/a.md",
    );
  });

  it("falls back to github.com for an unusable reported URL", () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/a/b",
      "https://u:p@github.com/a/b",
    ]) {
      expect(url("docs/a.md", "main", bad)).toBe("https://github.com/acme/api/blob/main/docs/a.md");
    }
  });

  it("encodes the owner and repository name", () => {
    expect(githubBlobUrl(null, "a/b", "c d", "main", "x.md")).toBe(
      "https://github.com/a%2Fb/c%20d/blob/main/x.md",
    );
  });
});
