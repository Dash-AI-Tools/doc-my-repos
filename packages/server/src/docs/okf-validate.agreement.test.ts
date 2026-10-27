import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDocumentRecord } from "../sync/document-record";
import { parseFrontmatter } from "./frontmatter";
import { detectOkf, isTypedConcept } from "./okf";
import {
  MAX_CONTENT_BYTES,
  validateOkfDocument,
  type FindingCode,
  type ValidationResult,
} from "./okf-validate";

/**
 * The validator and the sync must never disagree (mcp-agent-access spec `okf-authoring`,
 * "Validation is safe and agrees with the portal"):
 *
 *  1. a document with no `error` finding is one the sync stores with a `type` and shows as an OKF
 *     concept (a reserved `index.md` / `log.md` is stored as reserved, never as a concept);
 *  2. a document with an `error` finding is one the sync would not treat as an OKF concept, with
 *     one stated exception: `field-shape`, where the portal keeps the document and its type and
 *     only drops the unusable field. It is an error so that the agent fixes the field instead of
 *     losing it silently.
 *
 * Both are checked on a corpus of fixtures and on every document of this repository's own `docs/`.
 */

const NOW = new Date("2026-10-16T12:00:00Z");
const DOCS_FOLDER = "docs";

interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  /** Codes that must be among the findings. */
  readonly expect?: readonly FindingCode[];
}

const fm = (block: string, body = "# Title\n\nText.\n") => `---\n${block}\n---\n\n${body}`;
const GOOD_FM = "type: Runbook\ndescription: How to do it.";

const FIXTURES: readonly Fixture[] = [
  // --- valid concepts
  { name: "a plain concept", path: "docs/a.md", content: fm(GOOD_FM) },
  {
    name: "a free-form type with spaces",
    path: "docs/a.md",
    content: fm('type: "Architecture Decision"\ndescription: d'),
  },
  { name: "a lower-case type", path: "docs/a.md", content: fm("type: runbook\ndescription: d") },
  { name: "a unicode type", path: "docs/a.md", content: fm("type: Beschreibung\ndescription: d") },
  {
    name: "a type with a long, allowed length",
    path: "docs/a.md",
    content: fm(`type: ${"x".repeat(256)}\ndescription: d`),
  },
  { name: "tags as a list", path: "docs/a.md", content: fm(`${GOOD_FM}\ntags: [a, b]`) },
  { name: "tags as one string", path: "docs/a.md", content: fm(`${GOOD_FM}\ntags: ops`) },
  { name: "a status", path: "docs/a.md", content: fm(`${GOOD_FM}\nstatus: stable`) },
  {
    name: "sources as text and mappings",
    path: "docs/a.md",
    content: fm(
      `${GOOD_FM}\nsources:\n  - https://example.com/a\n  - {title: Spec, url: https://example.com/b}`,
    ),
  },
  {
    name: "valid dates",
    path: "docs/a.md",
    content: fm(
      `${GOOD_FM}\ngenerated: 2026-10-01\nverified: 2026-10-02T09:30:00Z\nstale_after: 2999-01-01`,
    ),
  },
  {
    name: "unknown keys",
    path: "docs/a.md",
    content: fm(`${GOOD_FM}\nowner_team: platform\nextra: {a: [1, 2]}`),
  },
  { name: "a nested document", path: "docs/guides/deep/a.md", content: fm(GOOD_FM) },
  { name: "an .mdx document", path: "docs/a.mdx", content: fm(GOOD_FM) },
  { name: "a BOM before the frontmatter", path: "docs/a.md", content: `\ufeff${fm(GOOD_FM)}` },
  { name: "CRLF line endings", path: "docs/a.md", content: fm(GOOD_FM).replace(/\n/g, "\r\n") },
  {
    name: "a closing fence of three dots",
    path: "docs/a.md",
    content: `---\n${GOOD_FM}\n...\n\n# T\n`,
  },
  {
    name: "duplicate keys (the last wins)",
    path: "docs/a.md",
    content: fm(`type: First\n${GOOD_FM}`),
  },
  {
    name: "a document with warnings only",
    path: "docs/a.md",
    content: fm("type: Runbook\nverified: not-a-date", "no heading\n"),
  },
  // --- reserved files
  { name: "index.md without frontmatter", path: "docs/index.md", content: "# Overview\n" },
  {
    name: "a nested index.md with a description",
    path: "docs/guides/index.md",
    content: fm("description: Guides", "# Guides\n"),
  },
  { name: "log.md without frontmatter", path: "docs/log.md", content: "# Change log\n" },
  {
    name: "index.md declaring okf_version",
    path: "docs/index.md",
    content: fm('okf_version: "0.2"\ndescription: d'),
  },
  {
    name: "index.md that wrongly declares a type",
    path: "docs/index.md",
    content: fm("type: Concept\ndescription: d"),
    expect: ["reserved-typed"],
  },
  // --- errors: the portal does not store a type
  {
    name: "no frontmatter",
    path: "docs/a.md",
    content: "# Title\n\nText.\n",
    expect: ["frontmatter-missing"],
  },
  {
    name: "an unclosed block",
    path: "docs/a.md",
    content: "---\ntype: Runbook\n# Title\n",
    expect: ["frontmatter-unclosed"],
  },
  {
    name: "invalid YAML",
    path: "docs/a.md",
    content: "---\ntype: [oops\n---\n# T\n",
    expect: ["frontmatter-invalid"],
  },
  {
    name: "a list instead of a mapping",
    path: "docs/a.md",
    content: "---\n- a\n- b\n---\n# T\n",
    expect: ["frontmatter-invalid"],
  },
  {
    name: "a block over 64 KB",
    path: "docs/a.md",
    content: `---\n${"k: v\n".repeat(20_000)}---\n# T\n`,
    expect: ["frontmatter-invalid"],
  },
  {
    name: "an alias bomb",
    path: "docs/a.md",
    // Each level repeats the one before it ten times: a billion values from a few lines.
    content: `---\n${[
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      ...Array.from("bcdefghi", (key, n) => {
        const previous = "abcdefgh"[n];
        return `${key}: &${key} [${Array(10).fill(`*${previous}`).join(", ")}]`;
      }),
      "type: T",
    ].join("\n")}\n---\n# T\n`,
    expect: ["frontmatter-invalid"],
  },
  {
    name: "CR-only line endings",
    path: "docs/a.md",
    content: fm(GOOD_FM).replace(/\n/g, "\r"),
    expect: ["frontmatter-invalid"],
  },
  {
    name: "an empty block",
    path: "docs/a.md",
    content: "---\n---\n\n# T\n",
    expect: ["type-missing"],
  },
  {
    name: "no type key",
    path: "docs/a.md",
    content: fm("description: d"),
    expect: ["type-missing"],
  },
  {
    name: "a null type",
    path: "docs/a.md",
    content: fm("type:\ndescription: d"),
    expect: ["type-missing"],
  },
  {
    name: "a blank type",
    path: "docs/a.md",
    content: fm('type: "   "\ndescription: d'),
    expect: ["type-missing"],
  },
  {
    name: "a numeric type",
    path: "docs/a.md",
    content: fm("type: 3\ndescription: d"),
    expect: ["type-not-text"],
  },
  {
    name: "a boolean type",
    path: "docs/a.md",
    content: fm("type: true\ndescription: d"),
    expect: ["type-not-text"],
  },
  {
    name: "a list type",
    path: "docs/a.md",
    content: fm("type: [a, b]\ndescription: d"),
    expect: ["type-not-text"],
  },
  {
    name: "a mapping type",
    path: "docs/a.md",
    content: fm("type: {a: 1}\ndescription: d"),
    expect: ["type-not-text"],
  },
  {
    name: "an over-long type",
    path: "docs/a.md",
    content: fm(`type: ${"x".repeat(257)}\ndescription: d`),
    expect: ["type-too-long"],
  },
  // --- errors that leave the type alone (the stated exception)
  {
    name: "tags that are a number",
    path: "docs/a.md",
    content: fm(`${GOOD_FM}\ntags: 3`),
    expect: ["field-shape"],
  },
  {
    name: "tags with a non-text entry",
    path: "docs/a.md",
    content: fm(`${GOOD_FM}\ntags: [a, 3]`),
    expect: ["field-shape"],
  },
  {
    name: "a status that is a list",
    path: "docs/a.md",
    content: fm(`${GOOD_FM}\nstatus: [a]`),
    expect: ["field-shape"],
  },
  {
    name: "sources that are a number",
    path: "docs/a.md",
    content: fm(`${GOOD_FM}\nsources: 5`),
    expect: ["field-shape"],
  },
  // --- too large
  {
    name: "content over the cap",
    path: "docs/a.md",
    content: `---\ntype: T\n---\n${"x".repeat(MAX_CONTENT_BYTES)}\n`,
    expect: ["content-too-large"],
  },
];

const ERROR_CODES_THAT_KEEP_THE_TYPE: ReadonlySet<FindingCode> = new Set(["field-shape"]);

function errorCodes(result: ValidationResult): FindingCode[] {
  return result.findings.filter((f) => f.severity === "error").map((f) => f.code);
}

/** What the sync does with `content`, for the checks below. */
function synced(path: string, content: string) {
  const built = buildDocumentRecord(path, content, { docsFolder: DOCS_FOLDER });
  if (!built.ok) return null;
  return built.record;
}

/** Property 1 and 2 for one document. */
function expectAgreement(label: string, path: string, content: string, result: ValidationResult) {
  const errors = errorCodes(result);
  const record = synced(path, content);

  if (errors.includes("content-too-large")) {
    expect(record, `${label}: the sync refuses the same content`).toBeNull();
    return;
  }
  expect(record, `${label}: the sync stores it`).not.toBeNull();
  if (record === null) return;
  const reserved = record.reserved !== null;

  if (result.valid) {
    if (reserved) {
      expect(
        isTypedConcept({ path, frontmatter: record.frontmatter }),
        `${label}: a reserved file is never a concept`,
      ).toBe(false);
      return;
    }
    expect(record.type, `${label}: no errors, so the sync stores a type`).not.toBeNull();
    expect(
      isTypedConcept({ path, frontmatter: record.frontmatter }),
      `${label}: and shows it as a concept`,
    ).toBe(true);
    expect(detectOkf([{ path, frontmatter: record.frontmatter }], DOCS_FOLDER).isOkf, label).toBe(
      true,
    );
    return;
  }

  // Errors. A type error means no type is stored; the one stated exception keeps it.
  if (errors.every((code) => ERROR_CODES_THAT_KEEP_THE_TYPE.has(code))) {
    expect(record.type, `${label}: field errors leave the type`).not.toBeNull();
    return;
  }
  expect(record.type, `${label}: an error, so the sync stores no type`).toBeNull();
}

describe("the validator agrees with the sync on a corpus of documents", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const result = validateOkfDocument(fixture.content, {
        path: fixture.path,
        docsFolder: DOCS_FOLDER,
        now: NOW,
      });
      for (const code of fixture.expect ?? []) {
        expect(
          result.findings.map((f) => f.code),
          `${fixture.name}: expected ${code}`,
        ).toContain(code);
      }
      expectAgreement(fixture.name, fixture.path, fixture.content, result);
    });
  }

  it("covers every error code and both outcomes", () => {
    const seen = new Set<FindingCode>();
    let valid = 0;
    let invalid = 0;
    for (const f of FIXTURES) {
      const result = validateOkfDocument(f.content, {
        path: f.path,
        docsFolder: DOCS_FOLDER,
        now: NOW,
      });
      if (result.valid) valid++;
      else invalid++;
      for (const finding of result.findings)
        if (finding.severity === "error") seen.add(finding.code);
    }
    expect([...seen].sort()).toEqual(
      [
        "content-too-large",
        "field-shape",
        "frontmatter-invalid",
        "frontmatter-missing",
        "frontmatter-unclosed",
        "type-missing",
        "type-not-text",
        "type-too-long",
      ].sort(),
    );
    expect(valid).toBeGreaterThan(15);
    expect(invalid).toBeGreaterThan(15);
  });
});

describe("the validator's reading of a broken block matches the parser's fixed warnings", () => {
  // `validateOkfDocument` tells an unclosed block from an unusable one by the parser's warning, so
  // a change to those texts must show up here and not as a silent change of error code.
  it("names an unclosed block by its warning", () => {
    expect(parseFrontmatter("---\ntype: T\n# Title\n").warnings).toEqual([
      "frontmatter ignored: opening --- has no closing fence",
    ]);
  });

  it.each([
    ["invalid YAML", "---\ntype: [oops\n---\n# T\n"],
    ["a non-mapping", "---\n- a\n---\n# T\n"],
  ])("starts the warning for %s with the ignored prefix and not the unclosed text", (_n, text) => {
    const warnings = parseFrontmatter(text).warnings;
    expect(warnings[0]).toMatch(/^frontmatter ignored:/);
    expect(warnings.join(" ")).not.toContain("no closing fence");
  });
});

describe("this repository's own docs", () => {
  const root = fileURLToPath(new URL("../../../../docs", import.meta.url));

  function markdownFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return markdownFiles(full);
      return /\.mdx?$/.test(entry.name) ? [full] : [];
    });
  }

  const files = markdownFiles(root).map((full) => ({
    path: `docs/${relative(root, full).split("\\").join("/")}`,
    content: readFileSync(full, "utf8"),
  }));
  const knownPaths = new Set(files.map((f) => f.path));

  it("finds the documentation set", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(knownPaths.has("docs/index.md")).toBe(true);
  });

  it("validates every document with no errors, links included", () => {
    const problems: string[] = [];
    for (const f of files) {
      const result = validateOkfDocument(f.content, {
        path: f.path,
        knownPaths,
        docsFolder: DOCS_FOLDER,
        now: NOW,
      });
      for (const finding of result.findings) {
        // Warnings that name a real problem in a shipped doc are listed with errors, so a doc
        // that links to a file that does not exist fails here too.
        if (finding.severity === "error" || finding.code === "link-broken") {
          problems.push(
            `${f.path}:${finding.line ?? "?"} ${finding.code} ${finding.excerpt ?? ""}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("agrees with the sync on every one of them", () => {
    for (const f of files) {
      const result = validateOkfDocument(f.content, {
        path: f.path,
        knownPaths,
        docsFolder: DOCS_FOLDER,
        now: NOW,
      });
      expectAgreement(f.path, f.path, f.content, result);
    }
  });
});
