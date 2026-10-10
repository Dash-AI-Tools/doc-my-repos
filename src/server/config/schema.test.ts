import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCS_PATHS,
  DEFAULT_MAX_DOCS_PER_REPO,
  DEFAULT_MAX_FILE_BYTES,
  MAX_DOCS_PER_REPO_LIMIT,
  MIN_FILE_BYTES_LIMIT,
  configSchema,
  formatConfigIssues,
} from "./schema";

function issues(input: unknown): string[] {
  const result = configSchema.safeParse(input);
  if (result.success) throw new Error("expected config to be rejected");
  return formatConfigIssues(result.error);
}

describe("configSchema valid configs", () => {
  it("accepts an empty config: every accessible repository is shown", () => {
    const cfg = configSchema.parse({});
    expect(cfg.repos).toBeUndefined();
    expect(cfg.exclude).toBeUndefined();
  });

  it("defaults docs folder candidates to docs, doc, documentation", () => {
    expect(configSchema.parse({}).defaults.docsPaths).toEqual(["docs", "doc", "documentation"]);
    expect(DEFAULT_DOCS_PATHS).toEqual(["docs", "doc", "documentation"]);
    expect(configSchema.parse({ defaults: {} }).defaults.docsPaths).toEqual([
      ...DEFAULT_DOCS_PATHS,
    ]);
  });

  it("accepts an explicit repository list", () => {
    const cfg = configSchema.parse({ repos: ["api-service", "web-app"] });
    expect(cfg.repos).toEqual(["api-service", "web-app"]);
  });

  it("accepts an exclusion list", () => {
    expect(configSchema.parse({ exclude: ["sandbox"] }).exclude).toEqual(["sandbox"]);
  });

  it("accepts a per-repo docsPath override", () => {
    const cfg = configSchema.parse({
      repos: ["api-service", { name: "web-app", docsPath: "handbook" }],
    });
    expect(cfg.repos?.[1]).toEqual({ name: "web-app", docsPath: "handbook" });
  });

  it("accepts an object repo entry without docsPath", () => {
    expect(configSchema.parse({ repos: [{ name: "web-app" }] }).repos).toEqual([
      { name: "web-app" },
    ]);
  });

  it("accepts custom defaults.docsPaths", () => {
    const cfg = configSchema.parse({ defaults: { docsPaths: ["handbook", "wiki/pages"] } });
    expect(cfg.defaults.docsPaths).toEqual(["handbook", "wiki/pages"]);
  });

  it("accepts repo names with dots, underscores and dashes", () => {
    expect(() => configSchema.parse({ repos: [".github", "my_repo.v2", "a-b"] })).not.toThrow();
  });
});

describe("configSchema invalid configs", () => {
  it("rejects a non-object root", () => {
    expect(configSchema.safeParse("nope").success).toBe(false);
    expect(configSchema.safeParse(null).success).toBe(false);
  });

  it("rejects repos of the wrong type and names the path", () => {
    expect(issues({ repos: "api-service" })).toEqual([expect.stringMatching(/^repos: /)]);
  });

  it("rejects a non-string entry in exclude and names the index", () => {
    expect(issues({ exclude: ["ok", 5] })).toEqual([expect.stringMatching(/^exclude\.1: /)]);
  });

  it("rejects docsPath of the wrong type and names the path", () => {
    expect(issues({ repos: [{ name: "web-app", docsPath: 3 }] })).toEqual([
      expect.stringMatching(/^repos\.0\.docsPath: /),
    ]);
  });

  it("rejects defaults.docsPaths that is not a list", () => {
    expect(issues({ defaults: { docsPaths: "docs" } })).toEqual([
      expect.stringMatching(/^defaults\.docsPaths: /),
    ]);
  });

  it("rejects an empty defaults.docsPaths", () => {
    expect(issues({ defaults: { docsPaths: [] } })).toEqual([
      expect.stringMatching(/^defaults\.docsPaths: /),
    ]);
  });

  it("rejects empty repos and exclude lists", () => {
    expect(issues({ repos: [] })[0]).toMatch(/^repos: /);
    expect(issues({ exclude: [] })[0]).toMatch(/^exclude: /);
  });

  it("rejects owner-qualified repository names", () => {
    expect(issues({ repos: ["acme/api-service"] }).join("\n")).toMatch(/owner prefix/);
    expect(issues({ exclude: ["acme/sandbox"] })[0]).toMatch(/^exclude\.0: /);
  });

  it("rejects invalid repository names", () => {
    for (const bad of ["", "has space", "..", ".", "a".repeat(101)]) {
      expect(configSchema.safeParse({ repos: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects docs paths that are absolute, traversing or blank", () => {
    for (const bad of ["/etc", "../x", "a/../b", "a\\b", "", ".", "./"]) {
      expect(
        configSchema.safeParse({ repos: [{ name: "r", docsPath: bad }] }).success,
        JSON.stringify(bad),
      ).toBe(false);
      expect(
        configSchema.safeParse({ defaults: { docsPaths: [bad] } }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("rejects repos and exclude together", () => {
    expect(issues({ repos: ["a"], exclude: ["b"] })).toEqual([
      "exclude: use either 'repos' or 'exclude', not both",
    ]);
  });

  it("rejects duplicate repositories case-insensitively", () => {
    expect(issues({ repos: ["Web-App", { name: "web-app" }] })).toEqual([
      "repos.1: duplicate repository",
    ]);
  });
});

describe("configSchema unknown fields", () => {
  it("rejects an unknown top-level field and names it", () => {
    expect(issues({ reposs: ["a"] })).toEqual(["reposs: unknown field"]);
  });

  it("rejects an org field: the GitHub App installation decides access", () => {
    expect(issues({ org: "acme" })).toEqual(["org: unknown field"]);
  });

  it("rejects secrets in the file", () => {
    expect(issues({ token: "ghp_x", privateKey: "k" })).toEqual([
      "token, privateKey: unknown field",
    ]);
  });

  it("rejects an unknown field inside defaults with its full path", () => {
    expect(issues({ defaults: { docPaths: ["docs"] } })).toEqual([
      "defaults.docPaths: unknown field",
    ]);
  });

  it("rejects an unknown field inside a repo entry with its full path", () => {
    expect(issues({ repos: [{ name: "web-app", docspath: "x" }] })).toEqual([
      "repos.0.docspath: unknown field",
    ]);
  });
});

describe("configSchema limits (task 12.3)", () => {
  it("defaults to 2000 documents per repository and 256 KB per file", () => {
    expect(configSchema.parse({}).limits).toEqual({
      maxDocsPerRepo: DEFAULT_MAX_DOCS_PER_REPO,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    });
    expect(DEFAULT_MAX_DOCS_PER_REPO).toBe(2000);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(262144);
    expect(configSchema.parse({ limits: {} }).limits.maxFileBytes).toBe(262144);
    expect(configSchema.parse({ limits: { maxDocsPerRepo: 50 } }).limits).toEqual({
      maxDocsPerRepo: 50,
      maxFileBytes: 262144,
    });
  });

  it("accepts the boundaries", () => {
    expect(
      configSchema.parse({ limits: { maxDocsPerRepo: 1, maxFileBytes: MIN_FILE_BYTES_LIMIT } })
        .limits,
    ).toEqual({ maxDocsPerRepo: 1, maxFileBytes: 1024 });
    expect(
      configSchema.parse({
        limits: { maxDocsPerRepo: MAX_DOCS_PER_REPO_LIMIT, maxFileBytes: 262144 },
      }).limits,
    ).toEqual({ maxDocsPerRepo: 10_000, maxFileBytes: 262144 });
  });

  it("rejects values outside the bounds, non-integers and unknown keys, naming the field", () => {
    expect(issues({ limits: { maxDocsPerRepo: 0 } })).toEqual([
      "limits.maxDocsPerRepo: maxDocsPerRepo must be at least 1",
    ]);
    expect(issues({ limits: { maxDocsPerRepo: 10_001 } })).toEqual([
      "limits.maxDocsPerRepo: maxDocsPerRepo must be at most 10000",
    ]);
    expect(issues({ limits: { maxDocsPerRepo: 2.5 } })).toEqual([
      "limits.maxDocsPerRepo: maxDocsPerRepo must be a whole number",
    ]);
    expect(issues({ limits: { maxDocsPerRepo: "100" } })).toEqual([
      "limits.maxDocsPerRepo: maxDocsPerRepo must be a whole number",
    ]);
    expect(issues({ limits: { maxFileBytes: 1023 } })).toEqual([
      "limits.maxFileBytes: maxFileBytes must be at least 1024",
    ]);
    expect(issues({ limits: { maxFileBytes: 262145 } })).toEqual([
      "limits.maxFileBytes: maxFileBytes must be at most 262144 (256 KB)",
    ]);
    expect(issues({ limits: { maxFiles: 5 } })).toEqual(["limits.maxFiles: unknown field"]);
    expect(issues({ limits: null })).toEqual([expect.stringMatching(/^limits: /)]);
  });
});
