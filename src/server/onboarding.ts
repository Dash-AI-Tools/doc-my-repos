import "server-only";

import { getCurrentUser } from "./auth/current-user";
import { getWorkspace } from "./workspace";

/**
 * First-run onboarding (workspace-settings): whether to show an administrator the setup banner,
 * which links to the Workspace configuration page and opens the GitHub instructions there. Only
 * administrators are affected; readers see the portal as usual. True when the viewer is an
 * administrator and the GitHub App is incomplete; false for anything else, including when the
 * settings or the session cannot be read (a down database must never put a banner in anyone's way).
 */
export interface OnboardingDeps {
  readonly user?: () => Promise<{ role: string } | null>;
  readonly missingGithub?: () => Promise<readonly string[]>;
}

export async function setupNeeded(deps: OnboardingDeps = {}): Promise<boolean> {
  try {
    const user = await (deps.user ?? (() => getCurrentUser()))();
    if (user === null || user.role !== "admin") return false;
    const missing = await (
      deps.missingGithub ?? (async () => (await getWorkspace()).problems.missingGithub)
    )();
    return missing.length > 0;
  } catch {
    return false;
  }
}
