import "server-only";

import type { WorkspaceStatusInput } from "@/lib/workspace-status";

import { retiredSources } from "./config/env";
import { getWorkspace } from "./workspace";

/**
 * What is missing or unreadable in the workspace, plus any retired variables still set in the
 * environment: names only, never values. Feeds the status page and the admin home. Rejects when
 * the settings cannot be loaded; callers leave the section out then.
 */
export async function currentWorkspaceState(): Promise<WorkspaceStatusInput> {
  const { problems } = await getWorkspace();
  return { ...problems, retired: retiredSources(process.env) };
}
