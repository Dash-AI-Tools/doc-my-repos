import { z } from "zod";

/** Default docs folder candidates, tried in order and matched case-insensitively. */
export const DEFAULT_DOCS_PATHS = ["docs", "doc", "documentation"] as const;

/** GitHub repository name (not owner/name): letters, digits, `.`, `_`, `-`, up to 100 chars. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const repoName = z
  .string()
  .min(1, "repository name must not be empty")
  .max(100, "repository name must be at most 100 characters")
  .regex(
    REPO_NAME_PATTERN,
    "repository name must be a bare name (letters, digits, '.', '_', '-'), without an owner prefix",
  )
  .refine((name) => name !== "." && name !== "..", "repository name is not valid");

/** A folder path relative to the repository root. No absolute paths, no traversal. */
const docsFolder = z
  .string()
  .min(1, "docs path must not be empty")
  .refine((p) => !p.startsWith("/"), "docs path must be relative to the repository root")
  .refine((p) => !p.includes("\\"), "docs path must use '/' separators")
  .refine((p) => !p.split("/").includes(".."), "docs path must not contain '..'")
  .refine(
    (p) =>
      p
        .replace(/\/+$/, "")
        .split("/")
        .some((s) => s !== "" && s !== "."),
    "docs path must name a folder",
  );

/** Most API spec files one repository can list (and sync). */
export const MAX_API_SPECS_PER_REPO = 10;

/**
 * Repository-relative path of one API spec file, normalized to `a/b/openapi.yaml` form (`./`
 * segments and repeated slashes dropped). Same rules as `docsFolder`, plus control characters are
 * refused and the path must name a file (no trailing slash).
 */
const apiSpecPath = z
  .string()
  .refine((p) => p.trim() !== "", "API spec path must not be empty")
  .refine((p) => !p.trim().startsWith("/"), "API spec path must be relative to the repository root")
  .refine((p) => !p.includes("\\"), "API spec path must use '/' separators")
  .refine(
    (p) => !/[\u0000-\u001f\u007f]/.test(p),
    "API spec path must not contain control characters",
  )
  .refine((p) => !p.split("/").includes(".."), "API spec path must not contain '..'")
  .refine((p) => !p.trim().endsWith("/"), "API spec path must name a file, not a folder")
  .transform((p) =>
    p
      .trim()
      .split("/")
      .filter((s) => s !== "" && s !== ".")
      .join("/"),
  )
  .refine((p) => p !== "", "API spec path must name a file")
  .refine((p) => p.length <= 1024, "API spec path is too long");

const apiSpecs = z
  .array(apiSpecPath)
  .min(1, "apiSpecs must list at least one path")
  .max(MAX_API_SPECS_PER_REPO, `apiSpecs must list at most ${MAX_API_SPECS_PER_REPO} paths`)
  .superRefine((paths, ctx) => {
    const seen = new Set<string>();
    paths.forEach((path, i) => {
      if (seen.has(path))
        ctx.addIssue({ code: "custom", path: [i], message: "duplicate API spec path" });
      seen.add(path);
    });
  });

const repoEntry = z.union([
  repoName,
  z.strictObject({
    name: repoName,
    docsPath: docsFolder.optional(),
    apiSpecs: apiSpecs.optional(),
  }),
]);

const defaults = z
  .strictObject({
    docsPaths: z
      .array(docsFolder)
      .min(1, "docsPaths must list at least one folder")
      .default([...DEFAULT_DOCS_PATHS]),
  })
  .prefault({});

/**
 * Per-repository sync limits (task 12.3). Defaults match the sync engine's code defaults
 * (`src/server/sync/tree.ts`). The file-size cap cannot go above 256 KB: a document's search vector
 * must stay well below Postgres's 1 MB tsvector limit (design, "Search column caveats").
 */
export const DEFAULT_MAX_DOCS_PER_REPO = 2000;
export const MAX_DOCS_PER_REPO_LIMIT = 10_000;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const MIN_FILE_BYTES_LIMIT = 1024;
/** API spec files (OpenAPI/Swagger) are stored apart from documents; the limit can only go down. */
export const DEFAULT_MAX_SPEC_BYTES = 2 * 1024 * 1024;
export const MIN_SPEC_BYTES_LIMIT = 1024;

const limits = z
  .strictObject({
    maxDocsPerRepo: z
      .int("maxDocsPerRepo must be a whole number")
      .min(1, "maxDocsPerRepo must be at least 1")
      .max(MAX_DOCS_PER_REPO_LIMIT, `maxDocsPerRepo must be at most ${MAX_DOCS_PER_REPO_LIMIT}`)
      .default(DEFAULT_MAX_DOCS_PER_REPO),
    maxFileBytes: z
      .int("maxFileBytes must be a whole number of bytes")
      .min(MIN_FILE_BYTES_LIMIT, `maxFileBytes must be at least ${MIN_FILE_BYTES_LIMIT}`)
      .max(
        DEFAULT_MAX_FILE_BYTES,
        `maxFileBytes must be at most ${DEFAULT_MAX_FILE_BYTES} (256 KB)`,
      )
      .default(DEFAULT_MAX_FILE_BYTES),
    maxSpecBytes: z
      .int("maxSpecBytes must be a whole number of bytes")
      .min(MIN_SPEC_BYTES_LIMIT, `maxSpecBytes must be at least ${MIN_SPEC_BYTES_LIMIT}`)
      .max(DEFAULT_MAX_SPEC_BYTES, `maxSpecBytes must be at most ${DEFAULT_MAX_SPEC_BYTES} (2 MB)`)
      .default(DEFAULT_MAX_SPEC_BYTES),
  })
  .prefault({});

/**
 * Background sync schedule (design: "Keep content fresh via webhooks, with a manual/scheduled
 * fallback"). `intervalMinutes` is the period of the full sync that catches lost webhook
 * deliveries: 0 turns periodic runs off, otherwise at least 5 minutes (each run lists the whole
 * installation and checks every repo's head) and at most a week. `onStartup` runs one full sync
 * shortly after the server starts. Whether the scheduler runs at all is an environment decision
 * (`SYNC_SCHEDULER`, see `src/server/sync/schedule-runtime.ts`), not a config one.
 */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
export const MIN_SYNC_INTERVAL_MINUTES = 5;
export const MAX_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;

const syncSchedule = z
  .strictObject({
    intervalMinutes: z
      .int("intervalMinutes must be a whole number of minutes")
      .max(
        MAX_SYNC_INTERVAL_MINUTES,
        `intervalMinutes must be at most ${MAX_SYNC_INTERVAL_MINUTES} (one week)`,
      )
      .refine(
        (minutes) => minutes === 0 || minutes >= MIN_SYNC_INTERVAL_MINUTES,
        `intervalMinutes must be 0 (off) or at least ${MIN_SYNC_INTERVAL_MINUTES}`,
      )
      .default(DEFAULT_SYNC_INTERVAL_MINUTES),
    onStartup: z.boolean("onStartup must be true or false").default(true),
  })
  .prefault({});

/**
 * Document comments (document-comments design decision 8). On by default; `enabled: false` removes
 * the section from document pages and makes the comment APIs answer 404. The admin page still
 * loads so stored comments can be purged.
 */
const comments = z
  .strictObject({
    enabled: z.boolean("enabled must be true or false").default(true),
  })
  .prefault({});

/**
 * Ask-the-docs limits (ask-the-docs design decision 8). There is no `enabled` key: on/off, provider
 * and model are an admin choice stored in the database; credentials come from the environment.
 */
export const ASK_LIMIT_DEFAULTS = {
  questionsPerDay: 100,
  questionsPerTenMinutes: 20,
  maxOutputTokens: 1000,
  maxConcurrent: 8,
} as const;

function askLimit(name: string, def: number, min: number, max: number) {
  return z
    .int(`${name} must be a whole number`)
    .min(min, `${name} must be at least ${min}`)
    .max(max, `${name} must be at most ${max}`)
    .default(def);
}

const ask = z
  .strictObject({
    questionsPerDay: askLimit("questionsPerDay", ASK_LIMIT_DEFAULTS.questionsPerDay, 1, 10_000),
    questionsPerTenMinutes: askLimit(
      "questionsPerTenMinutes",
      ASK_LIMIT_DEFAULTS.questionsPerTenMinutes,
      1,
      1000,
    ),
    maxOutputTokens: askLimit("maxOutputTokens", ASK_LIMIT_DEFAULTS.maxOutputTokens, 100, 8000),
    maxConcurrent: askLimit("maxConcurrent", ASK_LIMIT_DEFAULTS.maxConcurrent, 1, 100),
  })
  .prefault({});

export const configSchema = z
  .strictObject({
    repos: z.array(repoEntry).min(1, "repos must list at least one repository").optional(),
    exclude: z.array(repoName).min(1, "exclude must list at least one repository").optional(),
    defaults,
    limits,
    sync: syncSchedule,
    comments,
    ask,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.repos && cfg.exclude) {
      ctx.addIssue({
        code: "custom",
        path: ["exclude"],
        message: "use either 'repos' or 'exclude', not both",
      });
    }
    const seen = new Set<string>();
    cfg.repos?.forEach((entry, i) => {
      const name = (typeof entry === "string" ? entry : entry.name).toLowerCase();
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", i],
          message: "duplicate repository",
        });
      }
      seen.add(name);
    });
  });

/** Parsed config with defaults applied. */
export type AppConfig = z.output<typeof configSchema>;
/** Config as written in the file. */
export type AppConfigInput = z.input<typeof configSchema>;
export type RepoEntry = z.output<typeof repoEntry>;

type Issue = z.core.$ZodIssue;
type Located = { path: PropertyKey[]; issue: Issue };

/** For unions, report the branch that got furthest into the input (deepest path). */
function flattenIssue(issue: Issue, base: PropertyKey[] = []): Located[] {
  const path = [...base, ...issue.path];
  if (issue.code === "invalid_union" && issue.errors.length > 0) {
    const branches = issue.errors.map((b) => b.flatMap((i) => flattenIssue(i, path)));
    const depth = (b: Located[]) => Math.max(0, ...b.map((x) => x.path.length));
    const best = branches.reduce((a, b) => (depth(b) > depth(a) ? b : a));
    if (best.length > 0) return best;
  }
  return [{ path, issue }];
}

/** Render zod issues as `path: message` lines naming the offending field. */
export function formatConfigIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((raw) =>
    flattenIssue(raw).map(({ path: parts, issue }) => {
      const path = parts.length > 0 ? parts.map(String).join(".") : "(root)";
      if (issue.code === "unrecognized_keys") {
        const keys = issue.keys.map((k) => (path === "(root)" ? k : `${path}.${k}`));
        return `${keys.join(", ")}: unknown field`;
      }
      return `${path}: ${issue.message}`;
    }),
  );
}
