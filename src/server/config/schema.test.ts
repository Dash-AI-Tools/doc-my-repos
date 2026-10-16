import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCS_PATHS,
  DEFAULT_MAX_DOCS_PER_REPO,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SPEC_BYTES,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_DOCS_PER_REPO_LIMIT,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_FILE_BYTES_LIMIT,
  MIN_SYNC_INTERVAL_MINUTES,
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
      maxSpecBytes: DEFAULT_MAX_SPEC_BYTES,
    });
    expect(DEFAULT_MAX_DOCS_PER_REPO).toBe(2000);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(262144);
    expect(configSchema.parse({ limits: {} }).limits.maxFileBytes).toBe(262144);
    expect(configSchema.parse({ limits: { maxDocsPerRepo: 50 } }).limits).toEqual({
      maxDocsPerRepo: 50,
      maxFileBytes: 262144,
      maxSpecBytes: 2097152,
    });
  });

  it("accepts the boundaries", () => {
    expect(
      configSchema.parse({ limits: { maxDocsPerRepo: 1, maxFileBytes: MIN_FILE_BYTES_LIMIT } })
        .limits,
    ).toEqual({ maxDocsPerRepo: 1, maxFileBytes: 1024, maxSpecBytes: DEFAULT_MAX_SPEC_BYTES });
    expect(
      configSchema.parse({
        limits: { maxDocsPerRepo: MAX_DOCS_PER_REPO_LIMIT, maxFileBytes: 262144 },
      }).limits,
    ).toEqual({ maxDocsPerRepo: 10_000, maxFileBytes: 262144, maxSpecBytes: 2097152 });
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

describe("configSchema API specs", () => {
  const withSpecs = (apiSpecs: unknown) => ({ repos: [{ name: "api", apiSpecs }] });

  it("accepts and normalizes per-repository apiSpecs", () => {
    const cfg = configSchema.parse(
      withSpecs(["openapi.yaml", "./api//v2/spec.yaml", " docs/swagger.json "]),
    );
    expect(cfg.repos?.[0]).toEqual({
      name: "api",
      apiSpecs: ["openapi.yaml", "api/v2/spec.yaml", "docs/swagger.json"],
    });
  });

  it("leaves apiSpecs unset by default and accepts exactly 10", () => {
    expect(configSchema.parse({ repos: [{ name: "api" }] }).repos?.[0]).toEqual({ name: "api" });
    const ten = Array.from({ length: 10 }, (_, i) => `s${i}.yaml`);
    expect(configSchema.parse(withSpecs(ten)).repos?.[0]).toEqual({ name: "api", apiSpecs: ten });
  });

  it("rejects traversal, absolute, backslash, control, folder and empty paths", () => {
    for (const bad of [
      "../x.yaml",
      "a/../../x.yaml",
      "/etc/x.yaml",
      "a\\b.yaml",
      "a/\u0000.yaml",
      "a/",
      "",
      "  ",
      "./",
      "a/\n.yaml",
    ]) {
      const result = configSchema.safeParse(withSpecs([bad]));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) {
        expect(formatConfigIssues(result.error)[0]).toMatch(/^repos\.0\.apiSpecs\.0: /);
      }
    }
  });

  it("rejects duplicates after normalization, naming the second", () => {
    expect(issues(withSpecs(["a.yaml", "./a.yaml"]))).toEqual([
      "repos.0.apiSpecs.1: duplicate API spec path",
    ]);
  });

  it("rejects more than 10 paths, an empty list and the wrong type", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `s${i}.yaml`);
    expect(issues(withSpecs(eleven))).toEqual([
      "repos.0.apiSpecs: apiSpecs must list at most 10 paths",
    ]);
    expect(issues(withSpecs([]))).toEqual([
      "repos.0.apiSpecs: apiSpecs must list at least one path",
    ]);
    expect(issues(withSpecs(7))).toEqual([expect.stringMatching(/^repos\.0\.apiSpecs: /)]);
    expect(issues(withSpecs([3]))).toEqual([expect.stringMatching(/^repos\.0\.apiSpecs\.0: /)]);
  });

  it("limits.maxSpecBytes defaults to 2 MB, can be lowered to 1024, never raised", () => {
    expect(DEFAULT_MAX_SPEC_BYTES).toBe(2097152);
    expect(configSchema.parse({ limits: { maxSpecBytes: 1024 } }).limits.maxSpecBytes).toBe(1024);
    expect(configSchema.parse({ limits: { maxSpecBytes: 2097152 } }).limits.maxSpecBytes).toBe(
      2097152,
    );
    expect(issues({ limits: { maxSpecBytes: 1023 } })).toEqual([
      "limits.maxSpecBytes: maxSpecBytes must be at least 1024",
    ]);
    expect(issues({ limits: { maxSpecBytes: 2097153 } })).toEqual([
      "limits.maxSpecBytes: maxSpecBytes must be at most 2097152 (2 MB)",
    ]);
    expect(issues({ limits: { maxSpecBytes: 1.5 } })).toEqual([
      "limits.maxSpecBytes: maxSpecBytes must be a whole number of bytes",
    ]);
  });
});

describe("configSchema sync schedule", () => {
  it("defaults to an hourly full sync and a startup sync", () => {
    expect(configSchema.parse({}).sync).toEqual({
      intervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
      onStartup: true,
    });
    expect(DEFAULT_SYNC_INTERVAL_MINUTES).toBe(60);
    expect(configSchema.parse({ sync: {} }).sync).toEqual({ intervalMinutes: 60, onStartup: true });
    expect(configSchema.parse({ sync: { onStartup: false } }).sync).toEqual({
      intervalMinutes: 60,
      onStartup: false,
    });
  });

  it("accepts 0 (periodic runs off) and the bounds", () => {
    expect(configSchema.parse({ sync: { intervalMinutes: 0 } }).sync.intervalMinutes).toBe(0);
    expect(
      configSchema.parse({ sync: { intervalMinutes: MIN_SYNC_INTERVAL_MINUTES } }).sync
        .intervalMinutes,
    ).toBe(5);
    expect(
      configSchema.parse({ sync: { intervalMinutes: MAX_SYNC_INTERVAL_MINUTES } }).sync
        .intervalMinutes,
    ).toBe(10080);
  });

  it("rejects intervals between 0 and 5, negatives, fractions, oversize values and unknown keys", () => {
    for (const minutes of [1, 4, -5]) {
      expect(issues({ sync: { intervalMinutes: minutes } })).toEqual([
        "sync.intervalMinutes: intervalMinutes must be 0 (off) or at least 5",
      ]);
    }
    expect(issues({ sync: { intervalMinutes: 7.5 } })).toEqual([
      "sync.intervalMinutes: intervalMinutes must be a whole number of minutes",
    ]);
    expect(issues({ sync: { intervalMinutes: "60" } })).toEqual([
      "sync.intervalMinutes: intervalMinutes must be a whole number of minutes",
    ]);
    expect(issues({ sync: { intervalMinutes: 10081 } })).toEqual([
      "sync.intervalMinutes: intervalMinutes must be at most 10080 (one week)",
    ]);
    expect(issues({ sync: { onStartup: "yes" } })).toEqual([
      "sync.onStartup: onStartup must be true or false",
    ]);
    expect(issues({ sync: { cron: "* * * * *" } })).toEqual(["sync.cron: unknown field"]);
    expect(issues({ sync: null })).toEqual([expect.stringMatching(/^sync: /)]);
  });
});

describe("configSchema comments", () => {
  it("is enabled by default, whether the key is absent or the section is empty", () => {
    expect(configSchema.parse({}).comments).toEqual({ enabled: true });
    expect(configSchema.parse({ comments: {} }).comments).toEqual({ enabled: true });
  });

  it("accepts an explicit true or false", () => {
    expect(configSchema.parse({ comments: { enabled: false } }).comments).toEqual({
      enabled: false,
    });
    expect(configSchema.parse({ comments: { enabled: true } }).comments.enabled).toBe(true);
  });

  it("rejects a non-boolean value, naming the field", () => {
    for (const value of ["false", "yes", 0, 1, null]) {
      expect(issues({ comments: { enabled: value } })).toEqual([
        "comments.enabled: enabled must be true or false",
      ]);
    }
  });

  it("rejects an unknown key under comments and a non-object section", () => {
    expect(issues({ comments: { enabled: true, moderated: true } })).toEqual([
      "comments.moderated: unknown field",
    ]);
    expect(issues({ comments: null })).toEqual([expect.stringMatching(/^comments: /)]);
  });
});

describe("configSchema ask limits", () => {
  const defaults = {
    questionsPerDay: 100,
    questionsPerTenMinutes: 20,
    maxOutputTokens: 1000,
    maxConcurrent: 8,
  };

  it("defaults when the section is absent or empty", () => {
    expect(configSchema.parse({}).ask).toEqual(defaults);
    expect(configSchema.parse({ ask: {} }).ask).toEqual(defaults);
  });

  it("accepts values within bounds, keeping the others at their defaults", () => {
    expect(configSchema.parse({ ask: { questionsPerDay: 5, maxConcurrent: 1 } }).ask).toEqual({
      ...defaults,
      questionsPerDay: 5,
      maxConcurrent: 1,
    });
  });

  it("rejects values outside the bounds, naming the field", () => {
    expect(issues({ ask: { questionsPerDay: 0 } })).toEqual([
      "ask.questionsPerDay: questionsPerDay must be at least 1",
    ]);
    expect(issues({ ask: { questionsPerDay: 10_001 } })).toEqual([
      "ask.questionsPerDay: questionsPerDay must be at most 10000",
    ]);
    expect(issues({ ask: { questionsPerTenMinutes: 1001 } })).toEqual([
      "ask.questionsPerTenMinutes: questionsPerTenMinutes must be at most 1000",
    ]);
    expect(issues({ ask: { maxOutputTokens: 99 } })).toEqual([
      "ask.maxOutputTokens: maxOutputTokens must be at least 100",
    ]);
    expect(issues({ ask: { maxOutputTokens: 8001 } })).toEqual([
      "ask.maxOutputTokens: maxOutputTokens must be at most 8000",
    ]);
    expect(issues({ ask: { maxConcurrent: 0 } })).toEqual([
      "ask.maxConcurrent: maxConcurrent must be at least 1",
    ]);
  });

  it("rejects non-numeric and fractional values", () => {
    for (const value of ["100", "many", null, true, 1.5]) {
      expect(issues({ ask: { questionsPerDay: value } })).toEqual([
        "ask.questionsPerDay: questionsPerDay must be a whole number",
      ]);
    }
  });

  it("rejects unknown keys, including a leftover enabled", () => {
    expect(issues({ ask: { enabled: true } })).toEqual(["ask.enabled: unknown field"]);
    expect(issues({ ask: { model: "x" } })).toEqual(["ask.model: unknown field"]);
    expect(issues({ ask: null })).toEqual([expect.stringMatching(/^ask: /)]);
  });
});

describe("configSchema GitHub identifiers and provider endpoint", () => {
  it("defaults to nothing set", () => {
    const config = configSchema.parse({});
    expect(config.github).toEqual({});
    expect(config.providers).toEqual({});
  });

  it("accepts positive integer ids and a secure endpoint", () => {
    const config = configSchema.parse({
      github: { appId: 123456, installationId: 7 },
      providers: { openaiBaseUrl: "https://models.example.com/v1" },
    });
    expect(config.github).toEqual({ appId: 123456, installationId: 7 });
    expect(
      configSchema.safeParse({ providers: { openaiBaseUrl: "http://127.0.0.1:11434/v1" } }).success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ providers: { openaiBaseUrl: "http://localhost:8000" } }).success,
    ).toBe(true);
  });

  it("rejects bad ids, naming the field", () => {
    for (const value of [0, -1, 1.5, "12", null]) {
      expect(issues({ github: { appId: value } })).toEqual([
        expect.stringMatching(/^github\.appId: appId must be /),
      ]);
    }
    expect(issues({ github: { installationId: 0 } })).toEqual([
      "github.installationId: installationId must be a positive integer",
    ]);
  });

  it("rejects insecure or malformed endpoints without echoing them", () => {
    const messages = [
      "http://models.example.com",
      "ftp://models.example.com",
      "https://user:hunter2@models.example.com",
      "not a url",
    ].map((url) => issues({ providers: { openaiBaseUrl: url } }).join("\n"));
    for (const message of messages) {
      expect(message).toMatch(/^providers\.openaiBaseUrl: openaiBaseUrl /);
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("models.example.com");
    }
  });

  it("rejects unknown keys in both blocks", () => {
    expect(issues({ github: { privateKey: "x" } })).toEqual(["github.privateKey: unknown field"]);
    expect(issues({ providers: { apiKey: "x" } })).toEqual(["providers.apiKey: unknown field"]);
  });
});
