import { loadConfig, type LoadedConfig } from "@/server/config/load";

/**
 * Read-only GitHub/sync configuration for the admin panel. Secrets are never included: only the
 * App/installation ids (needed to identify the installation) and the repo scope from
 * `docmyrepos.config.yml`. The private key, webhook secret and sync secret stay env-only.
 */
export interface GithubConfigSummary {
  githubAppId: number;
  githubAppInstallationId: number;
  configFile: string;
  configFound: boolean;
  /** Explicit `repos` list, or null when every accessible repo is synced. */
  repos: readonly string[] | null;
  exclude: readonly string[];
}

export function summarizeGithubConfig(loaded: LoadedConfig): GithubConfigSummary {
  return {
    githubAppId: loaded.env.githubAppId,
    githubAppInstallationId: loaded.env.githubAppInstallationId,
    configFile: loaded.configFile.path,
    configFound: loaded.configFile.found,
    repos: loaded.config.repos
      ? [...loaded.config.repos.map((r) => (typeof r === "string" ? r : r.name))]
      : null,
    exclude: loaded.config.exclude ? [...loaded.config.exclude] : [],
  };
}

/** Loads and summarizes; throws ConfigError when the deployment is misconfigured. */
export function readGithubConfigSummary(): GithubConfigSummary {
  return summarizeGithubConfig(loadConfig());
}
