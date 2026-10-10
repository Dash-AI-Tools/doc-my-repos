import type { AppConfig } from "../config/schema";
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
  config: { docsPath?: string };
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

export async function discoverRepositories(
  client: DiscoveryClient,
  config: Pick<AppConfig, "repos" | "exclude">,
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

  const wanted = new Map<string, { name: string; docsPath?: string }>();
  for (const entry of config.repos ?? []) {
    const name = typeof entry === "string" ? entry : entry.name;
    const key = name.toLowerCase();
    if (wanted.has(key)) continue;
    wanted.set(key, {
      name,
      docsPath: typeof entry === "string" ? undefined : entry.docsPath,
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
      config: entry?.docsPath === undefined ? {} : { docsPath: entry.docsPath },
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
