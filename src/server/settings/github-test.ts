import { Secret } from "../config/secret";
import { createInstallationTokenProvider } from "../github/app-auth";
import { createGitHubClient, GitHubError } from "../github/client";

/**
 * The admin "Test" button for GitHub (workspace-settings task 4.2): mint an installation token and
 * list the repositories the installation can access, which is one read-only round trip. The result
 * is one of five fixed words plus a count; GitHub text, URLs, tokens and keys never leave here.
 */

export type GithubTestResult = "ok" | "rejected" | "not_found" | "unavailable" | "timeout";

export interface GithubTestOutcome {
  readonly result: GithubTestResult;
  /** How many repositories the installation can access (only for `ok`). */
  readonly repositories?: number;
}

export interface GithubTestInput {
  readonly appId: number;
  readonly installationId: number;
  readonly privateKey: Secret<string>;
}

export interface GithubTestOptions {
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
}

export const GITHUB_TEST_DEADLINE_MS = 20_000;

export function githubResultFor(error: unknown): GithubTestResult {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (!(error instanceof GitHubError)) return "unavailable";
  switch (error.kind) {
    case "app_credentials":
    case "invalid_private_key":
    case "unauthorized":
      return "rejected";
    case "installation_unavailable":
    case "not_found":
      return "not_found";
    case "aborted":
      return "timeout";
    default:
      return "unavailable";
  }
}

/** Never throws, never changes any saved setting. */
export async function testGithub(
  input: GithubTestInput,
  options: GithubTestOptions = {},
): Promise<GithubTestOutcome> {
  try {
    const tokens = createInstallationTokenProvider({
      appId: input.appId,
      installationId: input.installationId,
      privateKey: input.privateKey,
      fetch: options.fetch,
      maxAttempts: 1,
    });
    const client = createGitHubClient({
      getToken: tokens.getToken,
      fetch: options.fetch,
      maxAttempts: 1,
    });
    const repos = await client.listInstallationRepositories({
      signal: AbortSignal.timeout(options.deadlineMs ?? GITHUB_TEST_DEADLINE_MS),
    });
    return { result: "ok", repositories: repos.length };
  } catch (error) {
    return { result: githubResultFor(error) };
  }
}
