import "server-only";

import { WORKSPACE, defaultAuthorize, type User } from "@docmyrepos/core";

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
  /** Whether the viewer administers the workspace. Default: the open-source rule (the role). */
  readonly isAdmin?: () => Promise<boolean>;
  readonly missingGithub?: () => Promise<readonly string[]>;
}

export async function setupNeeded(deps: OnboardingDeps = {}): Promise<boolean> {
  try {
    const user = await (deps.user ?? (() => getCurrentUser()))();
    if (user === null) return false;
    const admin = deps.isAdmin
      ? await deps.isAdmin()
      : defaultAuthorize(user as User, "admin.manage", WORKSPACE);
    if (!admin) return false;
    const missing = await (
      deps.missingGithub ?? (async () => (await getWorkspace()).problems.missingGithub)
    )();
    return missing.length > 0;
  } catch {
    return false;
  }
}

/** `setupNeeded` for the request context's user and tenant. */
export function setupNeededFor(ctx: {
  user(): Promise<{ role: string } | null>;
  can(action: "admin.manage"): Promise<boolean>;
  workspace(): Promise<{ problems: { missingGithub: readonly string[] } }>;
}): Promise<boolean> {
  return setupNeeded({
    user: () => ctx.user(),
    isAdmin: () => ctx.can("admin.manage"),
    missingGithub: async () => (await ctx.workspace()).problems.missingGithub,
  });
}
