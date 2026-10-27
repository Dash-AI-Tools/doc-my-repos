import "server-only";

import type { WorkspaceStatusInput } from "@docmyrepos/core/internal/workspace-status";

import { retiredSources } from "./config/env";
import { getWorkspace, type WorkspaceSource } from "./workspace";

/**
 * What is missing or unreadable in the workspace, plus any retired variables still set in the
 * environment: names only, never values. Feeds the status page and the admin home. Rejects when
 * the settings cannot be loaded; callers leave the section out then.
 */
export async function currentWorkspaceState(ctx?: WorkspaceSource): Promise<WorkspaceStatusInput> {
  const { problems } = await (ctx ? ctx.workspace() : getWorkspace());
  return { ...problems, retired: retiredSources(process.env) };
}
