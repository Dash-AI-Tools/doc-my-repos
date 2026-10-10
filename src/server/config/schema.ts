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

const repoEntry = z.union([
  repoName,
  z.strictObject({
    name: repoName,
    docsPath: docsFolder.optional(),
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

export const configSchema = z
  .strictObject({
    repos: z.array(repoEntry).min(1, "repos must list at least one repository").optional(),
    exclude: z.array(repoName).min(1, "exclude must list at least one repository").optional(),
    defaults,
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
