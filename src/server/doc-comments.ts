import "server-only";

import { toThreadData, type DocCommentsData } from "@/lib/comments-view";

import { getCurrentUser } from "./auth/current-user";
import { DEFAULT_BRANDING, getBranding } from "./branding";
import type { Db } from "./db/client";
import { logger } from "./log";
import { countDocComments, listDocComments } from "./queries";
import { getRuntime } from "./runtime";

/**
 * Comments data for the document page (document-comments task 4.1). Reads through the query layer
 * only (`listDocComments`, `countDocComments`), so a hidden repository or a missing document gives
 * nothing, and never reaches GitHub. The page passes the result to `CommentsSection` as props, so
 * `src/components/` stays free of the database.
 *
 * - `disabled`: `comments.enabled` is false; the page renders no section and no count link.
 * - `hidden`: no signed-in user (comments are for signed-in users only).
 * - `unavailable`: the read failed; the page shows a short notice instead of the section.
 */

export interface DocCommentsDeps {
  readonly db?: () => Db;
  readonly enabled?: () => boolean;
  readonly user?: (db: Db) => Promise<{ id: number; role: "admin" | "user" } | null>;
  readonly orgName?: () => Promise<string | null>;
  readonly now?: () => Date;
}

export const DEFAULT_ORG_NAME = "Organization";

export async function loadDocComments(
  owner: string,
  name: string,
  path: string,
  deps: DocCommentsDeps = {},
): Promise<DocCommentsData> {
  try {
    const enabled = (deps.enabled ?? (() => getRuntime().loaded.config.comments.enabled))();
    if (!enabled) return { status: "disabled" };
    const db = (deps.db ?? (() => getRuntime().db.db))();
    const user = await (deps.user ?? getCurrentUser)(db);
    if (user === null) return { status: "hidden" };
    const isAdmin = user.role === "admin";
    const ref = { owner, name };
    const [page, counts, orgName] = await Promise.all([
      listDocComments(db, { repo: ref, path, includeEmail: isAdmin }),
      countDocComments(db, { repo: ref, path }),
      (deps.orgName ?? defaultOrgName)().catch(() => null),
    ]);
    return {
      status: "ready",
      repo: `${owner}/${name}`,
      path,
      threads: page.threads.map(toThreadData),
      nextCursor: page.nextCursor,
      counts,
      viewer: { userId: user.id, isAdmin },
      orgName: orgName ?? DEFAULT_ORG_NAME,
      loadedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
  } catch {
    try {
      logger.error("comments.page.failed", { action: "page" });
    } catch {
      // ignore
    }
    return { status: "unavailable" };
  }
}

async function defaultOrgName(): Promise<string | null> {
  return (await getBranding().catch(() => DEFAULT_BRANDING)).orgName;
}
