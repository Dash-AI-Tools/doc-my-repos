import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Static checks of the GitHub App setup guide (spec deployment-and-oss, "GitHub App setup guide",
 * scenario "Operator follows the guide"). Whether an operator really ends with a working App needs
 * a real GitHub organization: that part is the manual check in
 * `openspec/changes/docmyrepos-mvp/scenario-coverage.md` (task 6.5). What can be checked without
 * GitHub is that the guide says what the spec requires and agrees with the code: read-only
 * permissions, the four subscribed events (each one handled by the webhook router), the webhook
 * URL (a route that exists) and secret, and the three App credentials (variables the example
 * environment file declares).
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (name: string) => readFileSync(resolve(ROOT, name), "utf8");

const guide = read("docs/github-app-setup.md");

describe("docs/github-app-setup.md", () => {
  it("asks for repository contents and metadata, read-only, and nothing else", () => {
    expect(guide).toMatch(/\|\s*Contents\s*\|\s*Read-only\s*\|/);
    expect(guide).toMatch(/\|\s*Metadata\s*\|\s*Read-only\s*\|/);
    expect(guide).toMatch(/Set no other repository permission/);
    expect(guide).not.toMatch(/read and write|read & write|read-write|write access/i);
    expect(guide).toMatch(/The App is read-only/);
  });

  it("names the four subscribed events, and the webhook router handles each of them", () => {
    const router = read("src/server/webhooks/router.ts");
    for (const event of ["push", "repository", "installation_repositories", "installation"]) {
      expect(guide, event).toMatch(new RegExp(`\\|\\s*\`${event}\`\\s*\\|`));
      expect(router, event).toContain(`"${event}"`);
    }
  });

  it("gives a webhook URL that is a real route, and explains the secret", () => {
    expect(guide).toContain("/api/webhooks/github");
    expect(existsSync(resolve(ROOT, "src/app/api/webhooks/github/route.ts"))).toBe(true);
    expect(guide).toMatch(/webhook secret/i);
    expect(guide).toContain("/admin/workspace");
  });

  it("explains where to find the App id, the private key and the installation id, and where they go", () => {
    const env = read(".env.example");
    for (const field of ["App ID", "Installation ID", "Private key", "Webhook secret"]) {
      expect(guide, field).toContain(field);
    }
    expect(guide).toMatch(/\*\*App id\.\*\*/);
    expect(guide).toMatch(/\*\*Private key\.\*\*/);
    expect(guide).toMatch(/\*\*Installation id\.\*\*/);
    // They are entered in the admin interface now, so the environment example no longer asks.
    for (const retired of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_WEBHOOK_SECRET",
    ]) {
      expect(guide, retired).not.toContain(retired);
      expect(env, retired).not.toMatch(new RegExp(`^${retired}=`, "m"));
    }
    expect(env).toMatch(/^SETTINGS_ENCRYPTION_KEY=/m);
    expect(guide).toContain("SETTINGS_ENCRYPTION_KEY");
  });

  it("never asks for a personal access token", () => {
    expect(guide).toMatch(/never uses a personal access token/);
    expect(guide).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|personal access token (as|in) /i);
  });
});
