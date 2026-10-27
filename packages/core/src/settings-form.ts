import type { AppConfig } from "./config/schema";

/**
 * Turns the settings the server sends into form text and back (workspace-settings design decision
 * 7). Pure, so every rule is testable without a browser. The server validates the result again
 * with the same schema; these helpers only decide how text becomes the object the schema checks,
 * and report line-level problems the schema could not locate.
 */

export type RepoMode = "all" | "only" | "except";

export interface SettingsFormState {
  readonly appId: string;
  readonly installationId: string;
  readonly mode: RepoMode;
  /** One repository per line. See `parseRepoLines` for the line format. */
  readonly repoLines: string;
  /** One folder per line. */
  readonly docsPaths: string;
  readonly maxDocsPerRepo: string;
  readonly maxFileBytes: string;
  readonly maxSpecBytes: string;
  readonly intervalMinutes: string;
  readonly onStartup: boolean;
  readonly commentsEnabled: boolean;
  readonly mcpEnabled: boolean;
  readonly questionsPerDay: string;
  readonly questionsPerTenMinutes: string;
  readonly maxOutputTokens: string;
  readonly maxConcurrent: string;
}

type RepoEntry = NonNullable<AppConfig["repos"]>[number];

export function formatRepoLines(repos: readonly RepoEntry[] | undefined): string {
  return (repos ?? [])
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const parts = [entry.name];
      if (entry.docsPath) parts.push(`docsPath=${entry.docsPath}`);
      if (entry.apiSpecs && entry.apiSpecs.length > 0) {
        parts.push(`apiSpecs=${entry.apiSpecs.join(",")}`);
      }
      return parts.join(" ");
    })
    .join("\n");
}

export type RepoLinesResult =
  | { readonly ok: true; readonly entries: RepoEntry[] }
  | { readonly ok: false; readonly errors: string[] };

/**
 * One repository per line: `name`, optionally followed by `docsPath=folder` and/or
 * `apiSpecs=path1,path2` separated by spaces. Blank lines are ignored. Errors name the line.
 */
export function parseRepoLines(text: string, allowOptions = true): RepoLinesResult {
  const entries: RepoEntry[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    const [name, ...options] = line.split(/\s+/);
    if (options.length === 0) {
      entries.push(name!);
      return;
    }
    if (!allowOptions) {
      errors.push(`Line ${index + 1}: only a repository name is allowed here.`);
      return;
    }
    const entry: { name: string; docsPath?: string; apiSpecs?: string[] } = { name: name! };
    for (const option of options) {
      const eq = option.indexOf("=");
      const key = eq < 0 ? option : option.slice(0, eq);
      const value = eq < 0 ? "" : option.slice(eq + 1);
      if (key === "docsPath" && value !== "") entry.docsPath = value;
      else if (key === "apiSpecs" && value !== "") entry.apiSpecs = value.split(",");
      else
        errors.push(`Line ${index + 1}: "${key}" is not understood. Use docsPath=… or apiSpecs=….`);
    }
    entries.push(entry);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

export function formFromSettings(settings: AppConfig): SettingsFormState {
  const mode: RepoMode = settings.repos ? "only" : settings.exclude ? "except" : "all";
  return {
    appId: settings.github.appId === undefined ? "" : String(settings.github.appId),
    installationId:
      settings.github.installationId === undefined ? "" : String(settings.github.installationId),
    mode,
    repoLines:
      mode === "only"
        ? formatRepoLines(settings.repos)
        : mode === "except"
          ? (settings.exclude ?? []).join("\n")
          : "",
    docsPaths: settings.defaults.docsPaths.join("\n"),
    maxDocsPerRepo: String(settings.limits.maxDocsPerRepo),
    maxFileBytes: String(settings.limits.maxFileBytes),
    maxSpecBytes: String(settings.limits.maxSpecBytes),
    intervalMinutes: String(settings.sync.intervalMinutes),
    onStartup: settings.sync.onStartup,
    commentsEnabled: settings.comments.enabled,
    mcpEnabled: settings.mcp.enabled,
    questionsPerDay: String(settings.ask.questionsPerDay),
    questionsPerTenMinutes: String(settings.ask.questionsPerTenMinutes),
    maxOutputTokens: String(settings.ask.maxOutputTokens),
    maxConcurrent: String(settings.ask.maxConcurrent),
  };
}

/** A whole number from text, `undefined` when blank (the default applies), NaN when not a number. */
function whole(text: string): number | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  return /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
}

export type BuildResult =
  | { readonly ok: true; readonly settings: Record<string, unknown> }
  | { readonly ok: false; readonly errors: string[] };

/**
 * The full settings object to save, from the form text and the settings it was loaded from (so
 * fields the form does not edit are kept). A field that is not a whole number is reported by
 * name; the server then applies the real range checks.
 */
export function buildSettings(form: SettingsFormState, base: AppConfig): BuildResult {
  const errors: string[] = [];
  const number = (label: string, text: string): number | undefined => {
    const n = whole(text);
    if (n !== undefined && Number.isNaN(n)) errors.push(`${label} must be a whole number.`);
    return n;
  };

  const appId = number("App ID", form.appId);
  const installationId = number("Installation ID", form.installationId);

  let repos: RepoEntry[] | undefined;
  let exclude: string[] | undefined;
  if (form.mode !== "all") {
    const parsed = parseRepoLines(form.repoLines, form.mode === "only");
    if (!parsed.ok) errors.push(...parsed.errors);
    else if (parsed.entries.length === 0) {
      errors.push(
        form.mode === "only"
          ? "List at least one repository, or choose all repositories."
          : "List at least one repository to leave out, or choose all repositories.",
      );
    } else if (form.mode === "only") repos = parsed.entries;
    else exclude = parsed.entries as string[];
  }

  const docsPaths = lines(form.docsPaths);
  const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

  const settings = {
    github: compact({ appId, installationId }),
    providers: base.providers,
    ...(repos ? { repos } : {}),
    ...(exclude ? { exclude } : {}),
    defaults: { docsPaths },
    limits: compact({
      maxDocsPerRepo: number("Documents per repository", form.maxDocsPerRepo),
      maxFileBytes: number("Largest document", form.maxFileBytes),
      maxSpecBytes: number("Largest API spec", form.maxSpecBytes),
    }),
    sync: compact({
      intervalMinutes: number("Sync interval", form.intervalMinutes),
      onStartup: form.onStartup,
    }),
    comments: { enabled: form.commentsEnabled },
    mcp: { enabled: form.mcpEnabled },
    ask: compact({
      questionsPerDay: number("Questions per day", form.questionsPerDay),
      questionsPerTenMinutes: number("Questions per ten minutes", form.questionsPerTenMinutes),
      maxOutputTokens: number("Answer length", form.maxOutputTokens),
      maxConcurrent: number("Answers at once", form.maxConcurrent),
    }),
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings };
}
