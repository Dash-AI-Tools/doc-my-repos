import { GitHubError, type CallOptions, type GitHubClient, type RepoInfo } from "../github/client";

/**
 * Repository discovery: which repositories the installation can access, narrowed by config.
 *
 * Pure over an injected client (only `listInstallationRepositories`) and the validated config. It
 * makes no deletion decision. The caller may apply the removal rule (a repo absent from a FULL
 * listing is removed) only when `complete` is true. A listing failure returns `complete: false`
 * with no repos at all, so it can never be mistaken for an empty installation.
 *
 * Config names are bare repository names (the schema rejects an owner prefix), so they are matched
 * against the listing's names case-insensitively, as GitHub does. Output keeps GitHub's canonical
 * owner and name.
 */

export const NOT_ACCESSIBLE_CODE = "not_accessible";
export const NOT_ACCESSIBLE_MESSAGE = "not accessible by the GitHub App";

export type DiscoveryClient = Pick<GitHubClient, "listInstallationRepositories">;

export interface DiscoveredRepo {
  githubId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: "public" | "private";
  archived: boolean;
  description: string | null;
  htmlUrl: string;
  /** Per-repo overrides from the config entry; empty when the entry is a bare name or absent. */
  config: { docsPath?: string; apiSpecs?: readonly string[] };
}

export interface SkippedRepo {
  githubId: number;
  owner: string;
  name: string;
  reason: "archived" | "excluded";
}

export interface InaccessibleRepo {
  /** The name as written in the config. */
  name: string;
  code: typeof NOT_ACCESSIBLE_CODE;
  message: typeof NOT_ACCESSIBLE_MESSAGE;
}

export type DiscoveryResult =
  | {
      complete: true;
      repos: DiscoveredRepo[];
      skipped: SkippedRepo[];
      inaccessible: InaccessibleRepo[];
    }
  | {
      /** The listing failed or was partial. Callers must not remove or sync-delete anything. */
      complete: false;
      error: GitHubError;
      repos: [];
      skipped: [];
      inaccessible: [];
    };

/**
 * The narrowing part of the config. Read-only, so the frozen config from `loadConfig` fits as is;
 * a plain `AppConfig` (config/schema) fits too.
 */
export interface DiscoveryConfig {
  readonly repos?: readonly (
    | string
    | { readonly name: string; readonly docsPath?: string; readonly apiSpecs?: readonly string[] }
  )[];
  readonly exclude?: readonly string[];
}

/** Where a repository name falls in the config narrowing (archived state is checked separately). */
export type NameSelection = "selected" | "excluded" | "not_listed";

/**
 * The config narrowing for one repository name, matched case-insensitively exactly as
 * `discoverRepositories` does: under an explicit `repos` list an unlisted name is `not_listed`;
 * a name in `exclude` is `excluded`; otherwise `selected`. Archived repos are skipped by the
 * caller, as discovery does.
 */
export function repoNameSelection(config: DiscoveryConfig, name: string): NameSelection {
  const key = name.toLowerCase();
  if (
    config.repos !== undefined &&
    !config.repos.some((e) => (typeof e === "string" ? e : e.name).toLowerCase() === key)
  ) {
    return "not_listed";
  }
  if ((config.exclude ?? []).some((n) => n.toLowerCase() === key)) return "excluded";
  return "selected";
}

export async function discoverRepositories(
  client: DiscoveryClient,
  config: DiscoveryConfig,
  options: CallOptions = {},
): Promise<DiscoveryResult> {
  let listing: RepoInfo[];
  try {
    listing = await client.listInstallationRepositories(options);
  } catch (error) {
    if (error instanceof GitHubError) {
      return { complete: false, error, repos: [], skipped: [], inaccessible: [] };
    }
    throw error;
  }

  // The same repository id twice is one repository; keep the first.
  const byId = new Map<number, RepoInfo>();
  for (const repo of listing) if (!byId.has(repo.id)) byId.set(repo.id, repo);
  const accessible = [...byId.values()];

  const wanted = new Map<
    string,
    { name: string; docsPath?: string; apiSpecs?: readonly string[] }
  >();
  for (const entry of config.repos ?? []) {
    const name = typeof entry === "string" ? entry : entry.name;
    const key = name.toLowerCase();
    if (wanted.has(key)) continue;
    wanted.set(key, {
      name,
      docsPath: typeof entry === "string" ? undefined : entry.docsPath,
      apiSpecs: typeof entry === "string" ? undefined : entry.apiSpecs,
    });
  }
  const excluded = new Set((config.exclude ?? []).map((n) => n.toLowerCase()));

  const repos: DiscoveredRepo[] = [];
  const skipped: SkippedRepo[] = [];
  const seenWanted = new Set<string>();

  for (const repo of accessible) {
    const key = repo.name.toLowerCase();
    const entry = wanted.get(key);
    if (config.repos !== undefined && entry === undefined) continue;
    if (entry !== undefined) seenWanted.add(key);

    const identity = { githubId: repo.id, owner: repo.owner, name: repo.name };
    // A repository the operator excluded is reported as excluded even when it is also archived.
    if (excluded.has(key)) {
      skipped.push({ ...identity, reason: "excluded" });
      continue;
    }
    if (repo.archived) {
      skipped.push({ ...identity, reason: "archived" });
      continue;
    }
    repos.push({
      ...identity,
      defaultBranch: repo.defaultBranch,
      visibility: repo.visibility,
      archived: repo.archived,
      description: repo.description,
      htmlUrl: repo.htmlUrl,
      config: {
        ...(entry?.docsPath === undefined ? {} : { docsPath: entry.docsPath }),
        ...(entry?.apiSpecs === undefined ? {} : { apiSpecs: entry.apiSpecs }),
      },
    });
  }

  const inaccessible: InaccessibleRepo[] = [];
  for (const [key, entry] of wanted) {
    if (!seenWanted.has(key)) {
      inaccessible.push({
        name: entry.name,
        code: NOT_ACCESSIBLE_CODE,
        message: NOT_ACCESSIBLE_MESSAGE,
      });
    }
  }

  return { complete: true, repos, skipped, inaccessible };
}
