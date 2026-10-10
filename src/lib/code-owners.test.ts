import { describe, expect, it } from "vitest";

import { groupByOwner, type RuleData } from "./code-owners";

const user = (handle: string) => ({ handle, kind: "user" as const });
const team = (handle: string) => ({ handle, kind: "team" as const });

describe("groupByOwner", () => {
  it("groups the spec example: @alice covers * and the team covers /docs/", () => {
    const rules: RuleData[] = [
      { pattern: "*", owners: [user("@alice")] },
      { pattern: "/docs/", owners: [team("@my-org/docs-team")] },
    ];
    expect(groupByOwner(rules)).toEqual([
      { key: "@alice", handle: "@alice", kind: "user", patterns: ["*"] },
      {
        key: "@my-org/docs-team",
        handle: "@my-org/docs-team",
        kind: "team",
        patterns: ["/docs/"],
      },
    ]);
  });

  it("lists an owner of several rules once, with the patterns in file order", () => {
    const groups = groupByOwner([
      { pattern: "*", owners: [user("@alice"), user("@bob")] },
      { pattern: "/docs/", owners: [user("@bob")] },
      { pattern: "*.ts", owners: [user("@alice")] },
    ]);
    expect(groups.map((g) => [g.handle, g.patterns])).toEqual([
      ["@alice", ["*", "*.ts"]],
      ["@bob", ["*", "/docs/"]],
    ]);
  });

  it("merges case variants under the first spelling", () => {
    const groups = groupByOwner([
      { pattern: "/a/", owners: [user("@Alice")] },
      { pattern: "/b/", owners: [user("@alice")] },
      { pattern: "/c/", owners: [team("@Acme/Docs")] },
      { pattern: "/d/", owners: [team("@acme/docs")] },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ handle: "@Alice", patterns: ["/a/", "/b/"] });
    expect(groups[1]).toMatchObject({ handle: "@Acme/Docs", patterns: ["/c/", "/d/"] });
  });

  it("lists a repeated pattern once per owner", () => {
    const groups = groupByOwner([
      { pattern: "*", owners: [user("@alice")] },
      { pattern: "/x/", owners: [user("@alice")] },
      { pattern: "*", owners: [user("@alice")] },
    ]);
    expect(groups[0]?.patterns).toEqual(["*", "/x/"]);
  });

  it("orders owners by first appearance, not alphabetically", () => {
    const groups = groupByOwner([
      { pattern: "*", owners: [user("@zed")] },
      { pattern: "/a/", owners: [user("@amy")] },
    ]);
    expect(groups.map((g) => g.handle)).toEqual(["@zed", "@amy"]);
  });

  it("ignores rules without owners and returns nothing for no rules", () => {
    expect(groupByOwner([])).toEqual([]);
    expect(groupByOwner([{ pattern: "/vendor/", owners: [] }])).toEqual([]);
    const groups = groupByOwner([
      { pattern: "/vendor/", owners: [] },
      { pattern: "*", owners: [user("@a")] },
    ]);
    expect(groups.map((g) => g.patterns)).toEqual([["*"]]);
  });

  it("keeps patterns that look like properties of Object as plain strings", () => {
    const groups = groupByOwner([
      { pattern: "__proto__", owners: [user("@__proto__")] },
      { pattern: "constructor", owners: [user("@constructor")] },
    ]);
    expect(groups.map((g) => g.patterns)).toEqual([["__proto__"], ["constructor"]]);
  });
});
