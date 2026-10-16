/**
 * The workspace line of the status page (workspace-settings "Unconfigured workspace is safe and
 * visible"): whether GitHub is configured and which settings are missing or unreadable, by name
 * only. Pure, and structural so components never import server modules.
 */

export interface WorkspaceStatusInput {
  /** `github.appId`, `github.installationId`, `github_private_key`. */
  readonly missingGithub: readonly string[];
  /** Why secrets cannot be read at all, or null. */
  readonly encryptionKey: string | null;
  /** Secrets that exist but cannot be decrypted. */
  readonly unreadable: readonly string[];
  readonly invalidStored: boolean;
  /** Retired variables or files still present; ignored. */
  readonly retired: readonly string[];
}

export interface WorkspaceStatusLine {
  readonly tone: "good" | "bad";
  readonly label: string;
  /** One sentence per problem; empty when everything is configured. */
  readonly details: readonly string[];
}

/** Display names for the settings the server reports, so the page reads in words. */
const SETTING_NAMES: Readonly<Record<string, string>> = {
  "github.appId": "the GitHub App ID",
  "github.installationId": "the installation ID",
  github_private_key: "the GitHub App private key",
  github_webhook_secret: "the webhook secret",
  anthropic_api_key: "the Anthropic API key",
  openai_api_key: "the OpenAI-compatible API key",
};

const nameOf = (setting: string): string => SETTING_NAMES[setting] ?? "a setting";

const list = (items: readonly string[]): string => items.join(", ");

export function workspaceStatusLine(input: WorkspaceStatusInput): WorkspaceStatusLine {
  const details: string[] = [];
  if (input.missingGithub.length > 0) {
    details.push(
      `Enter ${list(input.missingGithub.map(nameOf))} on the Workspace configuration page to sync and show repositories.`,
    );
  }
  if (input.encryptionKey !== null) {
    details.push(`${input.encryptionKey}. Stored secrets cannot be read or saved until it is set.`);
  }
  if (input.unreadable.length > 0) {
    details.push(
      `${list(input.unreadable.map(nameOf))} cannot be read with the current encryption key; enter it again on the admin page.`,
    );
  }
  if (input.invalidStored) {
    details.push(
      "The saved settings are not valid; defaults are in use until an admin saves them again.",
    );
  }
  if (input.retired.length > 0) {
    details.push(
      input.retired.length === 1
        ? `${list(input.retired)} is still present but no longer read; enter its values on the admin pages and remove it.`
        : `${list(input.retired)} are still present but no longer read; enter their values on the admin pages and remove them.`,
    );
  }
  const bad = details.length > 0;
  return {
    tone: bad ? "bad" : "good",
    label: bad ? "Needs attention" : "Configured",
    details,
  };
}
