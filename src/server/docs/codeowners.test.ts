import { describe, expect, it } from "vitest";

import {
  MAX_CODEOWNERS_BYTES,
  MAX_CODEOWNERS_LINE_CHARS,
  MAX_CODEOWNERS_RULES,
  MAX_CODEOWNERS_WARNINGS,
  MAX_OWNERS_PER_RULE,
  parseCodeowners,
  parseOwner,
} from "./codeowners";

describe("parseOwner", () => {
  it("classifies users, teams and emails, keeping case", () => {
    expect(parseOwner("@Alice")).toEqual({ handle: "@Alice", kind: "user" });
    expect(parseOwner("@my-org/docs-team")).toEqual({ handle: "@my-org/docs-team", kind: "team" });
    expect(parseOwner("@my-org/team.v2_x")).toEqual({ handle: "@my-org/team.v2_x", kind: "team" });
    expect(parseOwner("dev@example.com")).toEqual({ handle: "dev@example.com", kind: "email" });
  });

  it("rejects invalid owners", () => {
    for (const bad of [
      "",
      "@",
      "alice",
      "@-alice/",
      "@a/b/c",
      "@org/",
      "@al ice",
      "@alice!",
      "a@b",
      "@a@b.com",
      "@" + "a".repeat(40),
      "x".repeat(300) + "@example.com",
    ]) {
      expect(parseOwner(bad), bad).toBeNull();
    }
  });
});

describe("parseCodeowners", () => {
  it("returns nothing for empty, blank and comment-only input", () => {
    expect(parseCodeowners("")).toEqual({ rules: [], warnings: [] });
    expect(parseCodeowners("\n  \n\t\n# a comment\n   # indented comment\n")).toEqual({
      rules: [],
      warnings: [],
    });
  });

  it("parses the spec example", () => {
    const r = parseCodeowners("* @alice\n/docs/ @my-org/docs-team\n");
    expect(r.warnings).toEqual([]);
    expect(r.rules).toEqual([
      { line: 1, pattern: "*", owners: [{ handle: "@alice", kind: "user" }] },
      { line: 2, pattern: "/docs/", owners: [{ handle: "@my-org/docs-team", kind: "team" }] },
    ]);
  });

  it("parses multiple owners of every kind, separated by spaces and tabs", () => {
    const r = parseCodeowners("*.md\t@alice   @my-org/docs \tdocs@example.com\n");
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.owners).toEqual([
      { handle: "@alice", kind: "user" },
      { handle: "@my-org/docs", kind: "team" },
      { handle: "docs@example.com", kind: "email" },
    ]);
  });

  it("drops trailing comments but keeps a # inside a token", () => {
    const r = parseCodeowners("*.md @alice # docs owner\n/a#b @bob#c\n/x/ @carol #note\n");
    expect(r.rules.map((x) => [x.line, x.pattern, x.owners.map((o) => o.handle)])).toEqual([
      [1, "*.md", ["@alice"]],
      [3, "/x/", ["@carol"]],
    ]);
    // `@bob#c` is not a valid owner, so line 2 is skipped.
    expect(r.warnings).toEqual(["CODEOWNERS line 2: invalid owner, line skipped"]);
  });

  it("keeps escaped # and escaped spaces in the pattern, verbatim", () => {
    const r = parseCodeowners("\\#notes.md @alice\nmy\\ file.md @bob\n/dir\\ name/ @carol # c\n");
    expect(r.warnings).toEqual([]);
    expect(r.rules.map((x) => [x.pattern, x.owners.map((o) => o.handle)])).toEqual([
      ["\\#notes.md", ["@alice"]],
      ["my\\ file.md", ["@bob"]],
      ["/dir\\ name/", ["@carol"]],
    ]);
  });

  it("treats a pattern with no owners as a valid rule with an empty owner list", () => {
    const r = parseCodeowners("* @alice\n/docs/internal/\n/vendor/ # unowned\n");
    expect(r.warnings).toEqual([]);
    expect(r.rules.map((x) => [x.pattern, x.owners.length])).toEqual([
      ["*", 1],
      ["/docs/internal/", 0],
      ["/vendor/", 0],
    ]);
  });

  it("handles CRLF, CR-only, LF and a BOM with correct line numbers", () => {
    const crlf = parseCodeowners("﻿# c\r\n\r\n* @a\r\n/x @b\r\n");
    expect(crlf.rules.map((x) => [x.line, x.pattern])).toEqual([
      [3, "*"],
      [4, "/x"],
    ]);
    expect(crlf.rules[0]?.owners).toEqual([{ handle: "@a", kind: "user" }]);
    const cr = parseCodeowners("* @a\r/x @b\r");
    expect(cr.rules.map((x) => [x.line, x.pattern])).toEqual([
      [1, "*"],
      [2, "/x"],
    ]);
    // A BOM must not hide a comment on line 1 or end up in the pattern.
    expect(parseCodeowners("﻿# only\n").rules).toEqual([]);
    expect(parseCodeowners("﻿* @a\n").rules[0]?.pattern).toBe("*");
  });

  it("keeps rules in file order, so the last matching rule is the later entry", () => {
    const r = parseCodeowners("* @default\n/docs/ @docs\n*.md @writers\n/docs/api/ @api\n");
    expect(r.rules.map((x) => x.pattern)).toEqual(["*", "/docs/", "*.md", "/docs/api/"]);
    expect(r.rules.map((x) => x.line)).toEqual([1, 2, 3, 4]);
    // Strictly increasing: a consumer can rely on array index and line for precedence.
    for (let i = 1; i < r.rules.length; i++) {
      expect(r.rules[i]!.line).toBeGreaterThan(r.rules[i - 1]!.line);
    }
  });

  it("keeps duplicate patterns as separate, ordered rules", () => {
    const r = parseCodeowners("*.md @a\n*.md @b\n");
    expect(r.rules.map((x) => x.owners[0]?.handle)).toEqual(["@a", "@b"]);
  });

  it("skips a line with any invalid owner, with a warning that does not quote it", () => {
    const r = parseCodeowners("* @alice\n/a/ @ok not-an-owner\n/b/ @bob\n/c/ @@@secret\n");
    expect(r.rules.map((x) => x.pattern)).toEqual(["*", "/b/"]);
    expect(r.warnings).toEqual([
      "CODEOWNERS line 2: invalid owner, line skipped",
      "CODEOWNERS line 4: invalid owner, line skipped",
    ]);
    expect(r.warnings.join()).not.toContain("secret");
  });

  it("skips a pattern that ends in a lone backslash", () => {
    const r = parseCodeowners("/a\\\n/b @bob\n");
    expect(r.rules.map((x) => x.pattern)).toEqual(["/b"]);
    expect(r.warnings).toEqual([
      "CODEOWNERS line 1: pattern ends in a lone backslash, line skipped",
    ]);
  });

  it("treats GitLab-style sections as ordinary patterns, warning on the brackets", () => {
    const r = parseCodeowners("[Docs] @alice\n^[Optional]\n");
    expect(r.rules.map((x) => [x.pattern, x.owners.length])).toEqual([
      ["[Docs]", 1],
      ["^[Optional]", 0],
    ]);
    expect(r.warnings).toEqual([
      "CODEOWNERS line 1: pattern uses syntax GitHub does not support",
      "CODEOWNERS line 2: pattern uses syntax GitHub does not support",
    ]);
  });

  it("warns on a negated pattern but keeps it as declared", () => {
    const r = parseCodeowners("!/docs/ @alice\n");
    expect(r.rules.map((x) => x.pattern)).toEqual(["!/docs/"]);
    expect(r.warnings).toHaveLength(1);
  });

  it("does not warn about an escaped bracket", () => {
    const r = parseCodeowners("a\\[b @alice\n");
    expect(r.warnings).toEqual([]);
    expect(r.rules).toHaveLength(1);
  });

  it("strips NULs and replaces lone surrogates", () => {
    const r = parseCodeowners("/a\u0000b @alice\n/\ud800x @bob\n");
    expect(r.rules.map((x) => x.pattern)).toEqual(["/ab", "/�x"]);
    for (const rule of r.rules) expect(rule.pattern.toWellFormed()).toBe(rule.pattern);
  });

  it("is deterministic and never throws on hostile input", () => {
    const hostile = [
      "\\",
      "\\\\",
      "#",
      "@",
      "\u0000",
      "\ud800",
      " \t ",
      "\r\r\n\n",
      "a".repeat(10),
    ];
    for (const input of hostile) {
      expect(() => parseCodeowners(input)).not.toThrow();
      expect(parseCodeowners(input)).toEqual(parseCodeowners(input));
    }
  });
});

describe("parseCodeowners limits", () => {
  it("ignores a file over the byte cap", () => {
    const r = parseCodeowners("*" + " ".repeat(MAX_CODEOWNERS_BYTES));
    expect(r.rules).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("larger than");
  });

  it("measures the cap in UTF-8 bytes", () => {
    // 3-byte characters: under the cap in chars, over it in bytes.
    const r = parseCodeowners("# " + "€".repeat(MAX_CODEOWNERS_BYTES / 2));
    expect(r.rules).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("skips an over-long rule line but not an over-long comment", () => {
    const long = "/" + "a".repeat(MAX_CODEOWNERS_LINE_CHARS);
    const r = parseCodeowners(`${long} @alice\n# ${long}\n/ok @bob\n`);
    expect(r.rules.map((x) => [x.line, x.pattern])).toEqual([[3, "/ok"]]);
    expect(r.warnings).toEqual(["CODEOWNERS line 1: line is too long, skipped"]);
  });

  it("caps owners per rule", () => {
    const owners = Array.from({ length: MAX_OWNERS_PER_RULE + 1 }, (_, i) => `@u${i}`).join(" ");
    const ok = Array.from({ length: MAX_OWNERS_PER_RULE }, (_, i) => `@u${i}`).join(" ");
    const r = parseCodeowners(`/a ${owners}\n/b ${ok}\n`);
    expect(r.rules.map((x) => x.pattern)).toEqual(["/b"]);
    expect(r.warnings).toEqual(["CODEOWNERS line 1: too many owners, line skipped"]);
  });

  it("caps the rule count and stops", () => {
    const lines = Array.from({ length: MAX_CODEOWNERS_RULES + 5 }, (_, i) => `/p${i} @a`);
    const r = parseCodeowners(lines.join("\n"));
    expect(r.rules).toHaveLength(MAX_CODEOWNERS_RULES);
    expect(r.rules.at(-1)?.pattern).toBe(`/p${MAX_CODEOWNERS_RULES - 1}`);
    expect(r.warnings).toHaveLength(1);
  });

  it("caps warnings and summarises the rest", () => {
    const bad = Array.from({ length: MAX_CODEOWNERS_WARNINGS + 7 }, () => "/a nope").join("\n");
    const r = parseCodeowners(bad);
    expect(r.rules).toEqual([]);
    expect(r.warnings).toHaveLength(MAX_CODEOWNERS_WARNINGS + 1);
    expect(r.warnings.at(-1)).toBe("CODEOWNERS: 7 further warnings omitted");
  });

  it("stays linear on pathological lines", () => {
    const start = performance.now();
    const n = 3000;
    parseCodeowners("\\ ".repeat(n) + " @a\n");
    parseCodeowners("a ".repeat(n) + "\n");
    parseCodeowners("x ".concat("@a".repeat(n), "\n"));
    parseCodeowners("x " + "a".repeat(n) + "@" + "a".repeat(n) + "\n");
    parseCodeowners("/a @b\n".repeat(50_000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
