import { describe, expect, it } from "vitest";

import {
  MAX_CONTENT_BYTES,
  validateOkfDocument,
  type Finding,
  type FindingCode,
  type ValidateOptions,
} from "./okf-validate";

const NOW = new Date("2026-10-16T12:00:00Z");

const doc = (frontmatter: string, body = "# Title\n\nText.\n"): string =>
  `---\n${frontmatter}\n---\n\n${body}`;

const GOOD = doc(
  "type: Runbook\ndescription: How to rotate keys.\ntags: [ops]\nstatus: stable\ngenerated: 2026-10-01\nverified: 2026-10-02",
);

const run = (content: string, options: ValidateOptions = {}) =>
  validateOkfDocument(content, { now: NOW, ...options });
const codes = (content: string, options?: ValidateOptions): FindingCode[] =>
  run(content, options).findings.map((f) => f.code);
const first = (content: string, code: FindingCode, options?: ValidateOptions): Finding => {
  const found = run(content, options).findings.find((f) => f.code === code);
  if (!found) throw new Error(`no ${code} finding`);
  return found;
};

describe("a valid document", () => {
  it("has no findings and is valid", () => {
    expect(run(GOOD)).toEqual({ valid: true, findings: [] });
  });

  it("stays valid with warnings and info only", () => {
    const result = run(doc("type: Runbook\nstatus: draft", "no heading here\n"));
    expect(result.valid).toBe(true);
    expect(result.findings.map((f) => f.severity).sort()).toEqual(["info", "warning", "warning"]);
  });

  it("is valid only when there is no error", () => {
    expect(run("# no frontmatter\n").valid).toBe(false);
    expect(run(doc("type: Runbook\ndescription: ok")).valid).toBe(true);
  });
});

describe("frontmatter errors", () => {
  it("reports missing frontmatter with a suggested block, at line 1", () => {
    const f = first("# Title\n\nText.\n", "frontmatter-missing", { path: "docs/a.md" });
    expect(f).toMatchObject({ severity: "error", line: 1 });
    expect(f.suggestion).toContain("type: Concept");
    expect(codes("# Title\n", { path: "docs/a.md" })).toEqual(["frontmatter-missing"]);
  });

  it("does not require frontmatter on the reserved index.md and log.md", () => {
    for (const path of ["docs/index.md", "docs/log.md", "docs/sub/INDEX.md"]) {
      const result = run("# Overview\n", { path });
      expect(result.valid, path).toBe(true);
      expect(
        result.findings.map((f) => f.code),
        path,
      ).toEqual(["description-missing"]);
    }
  });

  it("reports a frontmatter block that is never closed, and nothing else", () => {
    const result = run("---\ntype: Runbook\n# Title\n\nText.\n");
    expect(result.findings.map((f) => f.code)).toEqual(["frontmatter-unclosed"]);
    expect(result.findings[0]).toMatchObject({ severity: "error", line: 1 });
    expect(result.valid).toBe(false);
  });

  it.each([
    ["not valid YAML", "---\ntype: [unclosed\n---\n# T\n"],
    ["a list, not a mapping", "---\n- a\n- b\n---\n# T\n"],
    ["a scalar", "---\njust text\n---\n# T\n"],
    ["tabs where YAML needs spaces", "---\nkey:\n\t- x\n---\n# T\n"],
    ["a block over 64 KB", `---\n${"k: v\n".repeat(20_000)}---\n# T\n`],
  ])("reports frontmatter that is %s as invalid, and nothing else", (_name, content) => {
    const result = run(content);
    expect(result.findings.map((f) => f.code)).toEqual(["frontmatter-invalid"]);
    expect(result.valid).toBe(false);
  });

  it("tells a CR-only file to use LF or CRLF", () => {
    const f = first("---\rtype: T\r---\r# T\r", "frontmatter-invalid");
    expect(f.suggestion).toBe("Save the file with LF or CRLF line endings.");
  });

  it("accepts an empty frontmatter block but asks for a type", () => {
    expect(codes("---\n---\n\n# T\n")).toEqual(["type-missing", "description-missing"]);
  });
});

describe("type", () => {
  it("is required: a missing key, null and a blank value are all missing", () => {
    for (const fm of ["description: x", "type:", 'type: ""', 'type: "   "', "type: null"]) {
      const f = first(doc(fm), "type-missing");
      expect(f).toMatchObject({ severity: "error", key: "type" });
    }
  });

  it("points at the line of the key when there is one", () => {
    expect(first(doc("description: x\ntype:"), "type-missing").line).toBe(3);
    expect(first(doc("description: x"), "type-missing").line).toBe(1);
  });

  it("must be text", () => {
    for (const fm of ["type: 3", "type: true", "type: [a, b]", "type: {a: 1}"]) {
      expect(first(doc(fm), "type-not-text"), fm).toMatchObject({ severity: "error", key: "type" });
    }
    expect(first(doc("description: x\ntype: 3"), "type-not-text").line).toBe(3);
  });

  it("must fit the portal's limit of 256 characters", () => {
    expect(codes(doc(`type: ${"x".repeat(256)}\ndescription: d`))).toEqual([]);
    expect(first(doc(`type: ${"x".repeat(257)}`), "type-too-long").severity).toBe("error");
  });

  it("is free-form: any case, spaces and unicode are accepted as written", () => {
    for (const type of ["runbook", "RUNBOOK", "Architecture Decision", "Beschreibung", "a/b"]) {
      expect(run(doc(`type: ${JSON.stringify(type)}\ndescription: d`)).valid, type).toBe(true);
    }
  });

  it("is not asked of a reserved file, and a declared one is only noted", () => {
    expect(run("---\ndescription: d\n---\n# T\n", { path: "docs/index.md" }).valid).toBe(true);
    const f = first("---\ntype: Concept\n---\n# Changes\n", "reserved-typed", {
      path: "docs/log.md",
    });
    expect(f).toMatchObject({ severity: "info", key: "type", line: 2 });
    expect(run("---\ntype: Concept\n---\n# Changes\n", { path: "docs/log.md" }).valid).toBe(true);
  });
});

describe("field shapes the portal would drop", () => {
  it.each([
    ["tags: 3", "tags"],
    ["tags: {a: 1}", "tags"],
    ["tags: [a, 3]", "tags"],
    ["tags: [a, [b]]", "tags"],
    [`tags: [${"x".repeat(257)}]`, "tags"],
    [`tags: [${Array.from({ length: 101 }, (_, i) => `t${i}`).join(", ")}]`, "tags"],
    ["status: 3", "status"],
    ["status: [a]", "status"],
    [`status: ${"x".repeat(257)}`, "status"],
    ["sources: 5", "sources"],
    ["sources: true", "sources"],
    ["sources: [a, 5]", "sources"],
  ])("reports %s as an unusable %s", (line, key) => {
    const f = first(doc(`type: T\ndescription: d\n${line}`), "field-shape");
    expect(f).toMatchObject({ severity: "error", key, line: 4 });
    expect(f.message).toContain(key);
  });

  it.each([
    "tags: ops",
    "tags: [ops, Billing]",
    "tags:",
    "status: stable",
    "status:",
    "sources: https://example.com/a",
    "sources: [https://example.com/a, {title: Spec, url: https://example.com/b}]",
    "sources: {title: Spec, url: https://example.com/b}",
    "sources:",
  ])("accepts %s", (line) => {
    expect(codes(doc(`type: T\ndescription: d\n${line}`))).not.toContain("field-shape");
  });
});

describe("dates", () => {
  it("warns about a date that is not a date, naming the key, the line and a short excerpt", () => {
    const f = first(doc("type: T\ndescription: d\nverified: 2026-02-29"), "date-invalid");
    expect(f).toMatchObject({
      severity: "warning",
      key: "verified",
      line: 4,
      excerpt: "2026-02-29",
    });
  });

  it.each([
    ["generated: yesterday", "generated"],
    ["generated: 20261001", "generated"],
    ["verified: 2026-13-01", "verified"],
    ["verified: [2026-10-01]", "verified"],
    ["stale_after: soon", "stale_after"],
  ])("warns about %s", (line, key) => {
    const result = run(doc(`type: T\ndescription: d\n${line}`));
    expect(result.findings.find((f) => f.code === "date-invalid")?.key).toBe(key);
    expect(result.valid).toBe(true);
  });

  it.each([
    "generated: 2026-10-01",
    "generated: 2026-10-01T09:30:00Z",
    "generated: 2026-10-01 09:30",
    "verified: 2024-02-29",
    "generated:",
  ])("accepts %s", (line) => {
    expect(codes(doc(`type: T\ndescription: d\n${line}`))).toEqual([]);
  });

  it("warns when stale_after has passed and not when it is in the future or absent", () => {
    expect(
      first(doc("type: T\ndescription: d\nstale_after: 2020-01-01"), "stale-past"),
    ).toMatchObject({
      severity: "warning",
      key: "stale_after",
      line: 4,
    });
    expect(codes(doc("type: T\ndescription: d\nstale_after: 2999-01-01"))).toEqual([]);
    expect(codes(doc("type: T\ndescription: d"))).toEqual([]);
  });

  it("treats a date alone as stale from the start of the next day, as the portal does", () => {
    const fm = "type: T\ndescription: d\nstale_after: 2026-10-16";
    expect(codes(doc(fm), { now: new Date("2026-10-16T23:59:00Z") })).toEqual([]);
    expect(codes(doc(fm), { now: new Date("2026-10-17T00:00:01Z") })).toEqual(["stale-past"]);
  });
});

describe("title and description", () => {
  it("warns about a missing or blank description", () => {
    expect(first(doc("type: T"), "description-missing")).toMatchObject({
      severity: "warning",
      key: "description",
    });
    expect(codes(doc('type: T\ndescription: "  "'))).toEqual(["description-missing"]);
    expect(codes(doc("type: T\ndescription: 3"))).toEqual(["description-missing"]);
  });

  it("warns about a description or title the portal would cut", () => {
    expect(
      first(doc(`type: T\ndescription: ${"d".repeat(1001)}`), "description-long").severity,
    ).toBe("warning");
    expect(codes(doc(`type: T\ndescription: ${"d".repeat(1000)}`))).toEqual([]);
    expect(
      first(doc(`type: T\ndescription: d\ntitle: ${"t".repeat(301)}`), "title-long"),
    ).toMatchObject({ key: "title", line: 4 });
    expect(codes(doc(`type: T\ndescription: d\ntitle: ${"t".repeat(300)}`))).toEqual([]);
  });

  it("warns about a first heading the portal would cut when there is no title key", () => {
    const f = first(doc("type: T\ndescription: d", `# ${"h".repeat(301)}\n`), "title-long");
    expect(f.severity).toBe("warning");
  });
});

describe("headings", () => {
  it("warns when there is no level-1 heading", () => {
    expect(codes(doc("type: T\ndescription: d", "## Only a second level\n"))).toEqual([
      "h1-missing",
    ]);
    expect(codes(doc("type: T\ndescription: d", "just text\n"))).toEqual(["h1-missing"]);
  });

  it("warns about a second level-1 heading, at its line", () => {
    const f = first(doc("type: T\ndescription: d", "# One\n\ntext\n\n# Two\n"), "h1-multiple");
    expect(f).toMatchObject({ severity: "warning", line: 10 });
  });

  it("ignores a # line inside a fenced code block and counts a setext heading", () => {
    const fenced = doc("type: T\ndescription: d", "# Real\n\n```sh\n# a comment\n```\n");
    expect(codes(fenced)).toEqual([]);
    const tilde = doc("type: T\ndescription: d", "# Real\n\n~~~\n# not a heading\n~~~\n");
    expect(codes(tilde)).toEqual([]);
    const setext = doc("type: T\ndescription: d", "Title\n=====\n");
    expect(codes(setext)).toEqual([]);
  });

  it("finds the body of a document that has no frontmatter block too (reserved file)", () => {
    expect(codes("text only\n", { path: "docs/index.md" })).toEqual([
      "description-missing",
      "h1-missing",
    ]);
  });
});

describe("relative links", () => {
  const known = new Set([
    "docs/index.md",
    "docs/guides/setup.md",
    "docs/guides/advanced/tuning.md",
    "docs/reference/index.md",
    "docs/data/schema.mdx",
    "docs/Upper.MD",
  ]);
  const check = (body: string, path = "docs/guides/new.md") =>
    run(doc("type: T\ndescription: d", `# T\n\n${body}\n`), { path, knownPaths: known });
  const broken = (body: string, path?: string) =>
    check(body, path).findings.filter((f) => f.code === "link-broken");

  it("flags a link to a document that is not there, with its line and an excerpt", () => {
    const f = broken("See [the plan](./plan.md).")[0];
    expect(f).toMatchObject({ severity: "warning", line: 8, excerpt: "./plan.md" });
  });

  it.each([
    "[a](./setup.md)",
    "[a](setup.md)",
    "[a](setup)",
    "[a](./setup.md#install)",
    "[a](setup.md?plain=1)",
    "[a](advanced/tuning.md)",
    "[a](../index.md)",
    "[a](../)",
    "[a](../reference/)",
    "[a](../reference)",
    "[a](../data/schema)",
    "[a](../Upper.md)",
    "[a](<setup.md>)",
    "[a](setup.md 'a title')",
    "[a](%73etup.md)",
    "[ref][r]\n\n[r]: ./setup.md",
  ])("accepts %s", (body) => {
    expect(broken(body), body).toEqual([]);
  });

  it.each([
    "[a](./nope.md)",
    "[a](nope)",
    "[a](../nope/)",
    "[a](advanced/missing.md)",
    "[a](../../x.md)".replace("../../", "../"),
    "[ref][r]\n\n[r]: ./gone.md",
  ])("flags %s", (body) => {
    expect(broken(body).length, body).toBeGreaterThanOrEqual(1);
  });

  it("does not check what it cannot know: URLs, anchors, mail, images, other files, site-root paths", () => {
    const body = [
      "[a](https://example.com/x.md)",
      "[a](//example.com/x.md)",
      "[a](mailto:me@example.com)",
      "[a](#section)",
      "![diagram](./diagram.png)",
      "[a](./openapi.yaml)",
      "[a](./image.png)",
      "[a](/docs/x.md)",
      "[a](../../../outside.md)",
      "[a]()",
      "<https://example.com/y.md>",
    ].join("\n\n");
    expect(broken(body)).toEqual([]);
  });

  it("does not treat a footnote definition as a link", () => {
    expect(broken("Text[^1].\n\n[^1]: The note, with a [link](./setup.md).")).toEqual([]);
    expect(broken("[^note]: Only text here.")).toEqual([]);
  });

  it("checks only links that resolve inside the docs folder", () => {
    // A README or a file elsewhere in the repository becomes a GitHub link in the portal.
    expect(
      broken("[a](../../README.md) [b](../../../CONTRIBUTING.md) [c](../../src/x.md)"),
    ).toEqual([]);
    expect(broken("[a](../../docs/nope.md)")).toHaveLength(1);
    expect(broken("[a](../../docs/guides/setup.md)")).toEqual([]);
  });

  it("takes the docs folder from the option, or else from the first folder of the path", () => {
    const body = doc("type: T\ndescription: d", "# T\n\n[a](./nope.md)\n");
    const only = new Set(["documentation/a.md"]);
    const run2 = (extra: ValidateOptions) =>
      run(body, { path: "documentation/a.md", knownPaths: only, ...extra }).findings;
    expect(run2({}).map((f) => f.code)).toEqual(["link-broken"]);
    expect(run2({ docsFolder: "documentation" }).map((f) => f.code)).toEqual(["link-broken"]);
    expect(run2({ docsFolder: "docs" })).toEqual([]);
    expect(run2({ docsFolder: "Documentation/" }).map((f) => f.code)).toEqual(["link-broken"]);
    // A document at the repository root has no folder to infer: nothing is checked.
    expect(
      run(body, { path: "README.md", knownPaths: new Set() }).findings.map((f) => f.code),
    ).toEqual([]);
  });

  it("does not look inside code", () => {
    expect(broken("`[a](./nope.md)`")).toEqual([]);
    expect(broken("```\n[a](./nope.md)\n```")).toEqual([]);
    expect(broken("~~~md\n[a](./nope.md)\n~~~")).toEqual([]);
    expect(broken("``[a](./nope.md)``")).toEqual([]);
  });

  it("resolves from the document's own folder", () => {
    expect(broken("[a](./setup.md)", "docs/guides/new.md")).toEqual([]);
    expect(broken("[a](./setup.md)", "docs/new.md")).toHaveLength(1);
    expect(broken("[a](./guides/setup.md)", "docs/new.md")).toEqual([]);
  });

  it("is off without the repository's paths or without the document's own path", () => {
    const body = doc("type: T\ndescription: d", "# T\n\n[a](./nope.md)\n");
    expect(codes(body, { path: "docs/a.md" })).toEqual([]);
    expect(codes(body, { knownPaths: known })).toEqual([]);
  });

  it("reports each broken link on its own line and caps the findings", () => {
    const many = Array.from({ length: 60 }, (_, i) => `[a](./missing-${i}.md)`).join("\n\n");
    const f = broken(many);
    expect(f).toHaveLength(25);
    expect(f[0]?.line).toBe(8);
    expect(f[1]?.line).toBe(10);
  });
});

describe("the repository's vocabulary", () => {
  const vocabulary = {
    types: ["Runbook", "Concept", "Decision"],
    tags: ["ops", "billing"],
    statuses: ["stable", "draft"],
  };
  const check = (frontmatter: string) =>
    run(doc(`description: d\n${frontmatter}`), { vocabulary }).findings;

  it("says nothing for values the repository already uses", () => {
    expect(check("type: Runbook\ntags: [ops, billing]\nstatus: stable")).toEqual([]);
  });

  it("notes a new type as info, listing the types in use, and stays valid", () => {
    const result = run(doc("type: Playbook\ndescription: d"), { vocabulary });
    expect(result.valid).toBe(true);
    const f = result.findings[0];
    expect(f).toMatchObject({
      code: "type-new",
      severity: "info",
      key: "type",
      excerpt: "Playbook",
      line: 2,
    });
    expect(f?.suggestion).toBe("Types in use: Runbook, Concept, Decision");
  });

  it("compares exactly: a different case is a new type", () => {
    expect(check("type: runbook").map((f) => f.code)).toEqual(["type-new"]);
  });

  it("notes each new tag and a new status", () => {
    const found = check("type: Runbook\ntags: [ops, cache, edge]\nstatus: review");
    expect(found.map((f) => [f.code, f.excerpt])).toEqual([
      ["tag-new", "cache"],
      ["tag-new", "edge"],
      ["status-new", "review"],
    ]);
    expect(found[0]?.suggestion).toBe("Tags in use: ops, billing");
  });

  it("caps new-tag findings at 10", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `n${i}`).join(", ");
    expect(
      check(`type: Runbook\ntags: [${tags}]`).filter((f) => f.code === "tag-new"),
    ).toHaveLength(10);
  });

  it("clips a long list of existing values", () => {
    const types = Array.from({ length: 25 }, (_, i) => `Type${i}`);
    const f = run(doc("type: Other\ndescription: d"), { vocabulary: { types } }).findings[0];
    expect(f?.suggestion).toMatch(/^Types in use: Type0, .*Type9, and 15 more$/);
  });

  it("compares nothing when there is no vocabulary, or when a list is empty", () => {
    expect(codes(doc("type: Anything\ndescription: d\ntags: [x]\nstatus: y"))).toEqual([]);
    const empty = { types: [], tags: [], statuses: [] };
    expect(
      codes(doc("type: Anything\ndescription: d\ntags: [x]\nstatus: y"), { vocabulary: empty }),
    ).toEqual([]);
    expect(codes(doc("type: Anything\ndescription: d"), { vocabulary: { tags: ["ops"] } })).toEqual(
      [],
    );
  });

  it("does not compare the type of a reserved file", () => {
    const content = "---\ntype: Weird\ndescription: d\n---\n# T\n";
    expect(codes(content, { path: "docs/index.md", vocabulary })).toEqual(["reserved-typed"]);
  });
});

describe("status notices", () => {
  it.each([
    ["draft", "status-draft"],
    ["Draft", "status-draft"],
    [" DRAFT ", "status-draft"],
    ["deprecated", "status-deprecated"],
    ["Deprecated", "status-deprecated"],
  ] as const)("notes status %j as info", (status, code) => {
    const result = run(doc(`type: T\ndescription: d\nstatus: ${JSON.stringify(status)}`));
    expect(result.findings).toEqual([
      expect.objectContaining({ code, severity: "info", key: "status" }),
    ]);
    expect(result.valid).toBe(true);
  });

  it("says nothing for other statuses", () => {
    expect(codes(doc("type: T\ndescription: d\nstatus: stable"))).toEqual([]);
  });
});

describe("size", () => {
  it("validates nothing above 256 KB and says so", () => {
    const big = `---\ntype: T\n---\n${"x".repeat(MAX_CONTENT_BYTES)}\n`;
    const result = run(big);
    expect(result).toEqual({
      valid: false,
      findings: [expect.objectContaining({ code: "content-too-large", severity: "error" })],
    });
  });

  it("counts bytes, not characters", () => {
    const wide = "é".repeat(MAX_CONTENT_BYTES / 2 + 1);
    expect(codes(wide)).toEqual(["content-too-large"]);
  });

  it("validates content right at the limit", () => {
    const head = "---\ntype: T\ndescription: d\n---\n\n# T\n\n";
    const body = "x".repeat(MAX_CONTENT_BYTES - head.length);
    expect(Buffer.byteLength(head + body)).toBe(MAX_CONTENT_BYTES);
    expect(codes(head + body)).toEqual([]);
  });

  it("answers a non-string without throwing", () => {
    expect(codes(undefined as unknown as string)).toEqual(["content-too-large"]);
  });
});

describe("what findings contain", () => {
  const SENTINEL = "ZQX-SECRET-INSTRUCTION-7731";

  it("uses fixed messages that never quote the document", () => {
    const content = doc(
      [
        `type: [${SENTINEL}]`,
        `tags: ${SENTINEL}${"x".repeat(300)}`,
        `status: [${SENTINEL}]`,
        `generated: ${SENTINEL}`,
        `verified: ${SENTINEL}`,
        `stale_after: ${SENTINEL}`,
        `sources: ${SENTINEL.length}`,
      ].join("\n"),
      `# One\n\n# Two\n\n[a](./${SENTINEL}.md)\n`,
    );
    const result = run(content, {
      path: "docs/a.md",
      knownPaths: new Set(["docs/a.md"]),
      vocabulary: { types: ["X"], tags: ["x"], statuses: ["x"] },
    });
    expect(result.findings.length).toBeGreaterThan(5);
    for (const f of result.findings) {
      expect(f.message, f.code).not.toContain(SENTINEL);
      expect(f.suggestion ?? "", f.code).not.toContain(SENTINEL);
    }
  });

  it("limits an excerpt to 80 characters and strips control and direction characters", () => {
    const value = `a‮b\u0007c​d${"e".repeat(200)}`;
    const f = first(
      doc(`type: T\ndescription: d\nverified: ${JSON.stringify(value)}`),
      "date-invalid",
    );
    expect(f.excerpt).toBeDefined();
    expect([...(f.excerpt as string)].length).toBeLessThanOrEqual(80);
    expect(f.excerpt).not.toMatch(/[‮\u0007​]/);
    expect(f.excerpt).toMatch(/^abcd/);
  });

  it("clips the repository's own vocabulary it lists, cleaned", () => {
    const types = ["T1‮" + "x".repeat(100), "T2"];
    const f = run(doc("type: New\ndescription: d"), { vocabulary: { types } }).findings[0];
    expect(f?.suggestion).not.toMatch(/‮/);
    expect(f?.suggestion?.length).toBeLessThan(80);
  });
});

describe("line numbers", () => {
  it("count from the first line of the content, through CRLF line endings and a BOM", () => {
    const lines = ["---", "type: T", "description: d", "verified: nope", "---", "", "# T"];
    expect(first(lines.join("\n"), "date-invalid").line).toBe(4);
    expect(first(lines.join("\r\n"), "date-invalid").line).toBe(4);
    expect(first(`﻿${lines.join("\n")}`, "date-invalid").line).toBe(4);
  });

  it("count body findings from the top of the file, past the frontmatter", () => {
    const content = doc("type: T\ndescription: d", "# T\n\nintro\n\n[a](./nope.md)\n");
    const f = first(content, "link-broken", { path: "docs/a.md", knownPaths: new Set() });
    expect(content.split("\n")[(f.line as number) - 1]).toContain("./nope.md");
  });
});

describe("hostile input", () => {
  const FAST_MS = 2000;
  const timed = (content: string, options?: ValidateOptions) => {
    const start = performance.now();
    const result = run(content, options);
    return { result, ms: performance.now() - start };
  };

  it("answers a huge frontmatter block quickly with an error", () => {
    const { result, ms } = timed(`---\n${"key: value\n".repeat(20_000)}---\n# T\n`);
    expect(result.findings.map((f) => f.code)).toEqual(["frontmatter-invalid"]);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("answers deeply nested frontmatter quickly with an error", () => {
    const deep = `a: ${"[".repeat(4000)}${"]".repeat(4000)}`;
    const { result, ms } = timed(`---\n${deep}\n---\n# T\n`);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe("frontmatter-invalid");
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("answers an alias bomb quickly with an error", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]",
      "f: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e, *e]",
      "g: &g [*f, *f, *f, *f, *f, *f, *f, *f, *f, *f]",
      "h: &h [*g, *g, *g, *g, *g, *g, *g, *g, *g, *g]",
      "i: &i [*h, *h, *h, *h, *h, *h, *h, *h, *h, *h]",
      "type: T",
    ].join("\n");
    const { result, ms } = timed(`---\n${bomb}\n---\n# T\n`);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe("frontmatter-invalid");
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("treats __proto__ and constructor keys as plain data and never pollutes Object", () => {
    const content = doc(
      'type: T\ndescription: d\n"__proto__":\n  polluted: yes\nconstructor:\n  prototype:\n    polluted: yes',
    );
    expect(run(content).valid).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("copes with NULs, control characters and lone surrogates in values", () => {
    const content = doc('type: T\ndescription: d\nverified: "a\u0000b\ud800\u0007"');
    const { result, ms } = timed(content);
    expect(result.findings.map((f) => f.code)).toEqual(["date-invalid"]);
    expect(JSON.stringify(result)).not.toContain("\u0000");
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("scans a body of many links, long lines and nested quotes in bounded time", () => {
    const links = Array.from({ length: 5000 }, (_, i) => `[a${i}](./m${i}.md)`).join(" ");
    const quotes = `${"> ".repeat(20_000)}deep`;
    const spans = "`".repeat(50_000);
    const body = `# T\n\n${links}\n\n${quotes}\n\n${spans}\n`;
    const { result, ms } = timed(doc("type: T\ndescription: d", body), {
      path: "docs/a.md",
      knownPaths: new Set(["docs/a.md"]),
    });
    expect(result.findings.filter((f) => f.code === "link-broken")).toHaveLength(25);
    expect(ms).toBeLessThan(FAST_MS * 3);
  });

  it("never throws, whatever the content", () => {
    for (const content of [
      "",
      "---",
      "---\n",
      "---\n---",
      "\u0000",
      "﻿",
      "---\r---\r",
      "---\n...\n",
      "# only a heading",
      "[](",
      "[a](<",
      "```",
    ]) {
      expect(
        () => run(content, { path: "docs/a.md", knownPaths: new Set() }),
        content,
      ).not.toThrow();
    }
  });
});
