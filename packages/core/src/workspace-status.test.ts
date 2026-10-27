import { describe, expect, it } from "vitest";

import { workspaceStatusLine, type WorkspaceStatusInput } from "./workspace-status";

const CLEAN: WorkspaceStatusInput = {
  missingGithub: [],
  encryptionKey: null,
  unreadable: [],
  invalidStored: false,
  retired: [],
};

describe("workspaceStatusLine", () => {
  it("is configured and silent when nothing is wrong", () => {
    expect(workspaceStatusLine(CLEAN)).toEqual({ tone: "good", label: "Configured", details: [] });
  });

  it("names what is missing in words, not as raw keys", () => {
    const line = workspaceStatusLine({
      ...CLEAN,
      missingGithub: ["github.appId", "github_private_key"],
    });
    expect(line.tone).toBe("bad");
    expect(line.details).toEqual([
      "Enter the GitHub App ID, the GitHub App private key on the Workspace configuration page to sync and show repositories.",
    ]);
  });

  it("reports an unusable encryption key, unreadable secrets and invalid stored settings", () => {
    const line = workspaceStatusLine({
      ...CLEAN,
      encryptionKey: "SETTINGS_ENCRYPTION_KEY: is not set",
      unreadable: ["github_webhook_secret", "anthropic_api_key"],
      invalidStored: true,
    });
    expect(line.details).toHaveLength(3);
    expect(line.details[0]).toMatch(/^SETTINGS_ENCRYPTION_KEY: is not set\./);
    expect(line.details[1]).toMatch(/the webhook secret, the Anthropic API key cannot be read/);
    expect(line.details[2]).toMatch(/not valid/);
  });

  it("says retired variables are ignored, by name only", () => {
    const one = workspaceStatusLine({ ...CLEAN, retired: ["GITHUB_APP_ID"] });
    expect(one.details).toEqual([
      "GITHUB_APP_ID is still present but no longer read; enter its values on the admin pages and remove it.",
    ]);
    const two = workspaceStatusLine({ ...CLEAN, retired: ["CONFIG_PATH", "AI_OPENAI_API_KEY"] });
    expect(two.details[0]).toMatch(
      /^CONFIG_PATH, AI_OPENAI_API_KEY are still present but no longer read/,
    );
  });

  it("never turns an unknown setting name into text", () => {
    const line = workspaceStatusLine({ ...CLEAN, missingGithub: ["sneaky\nname"] });
    expect(JSON.stringify(line)).not.toContain("sneaky");
  });
});
