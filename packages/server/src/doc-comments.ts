import "server-only";

import { toThreadData, type DocCommentsData } from "@docmyrepos/core/internal/comments-view";

import type { User } from "@docmyrepos/core";

import { type Access, legacyAccess } from "./auth/access";
import { threadWithPermissions } from "./comments/permissions";
import { DEFAULT_BRANDING, getBranding } from "./branding";
import { type Db, type DbSource } from "./db/client";
import { logger } from "./log";
import { countDocComments, listDocComments } from "./queries";
import { commentsEnabled } from "./workspace";

/**
 * Comments data for the document page (document-comments task 4.1). Reads through the query layer
 * only (`listDocComments`, `countDocComments`), so a hidden repository or a missing document gives
 * nothing, and never reaches GitHub. The page passes the result to `CommentsSection` as props, so
 * `packages/ui/src/components/` stays free of the database.
 *
 * - `disabled`: `comments.enabled` is false; the page renders no section and no count link.
 * - `hidden`: no signed-in user (comments are for signed-in users only).
 * - `unavailable`: the read failed; the page shows a short notice instead of the section.
 */

export interface DocCommentsDeps {
  readonly db: DbSource;
  readonly enabled?: () => boolean | Promise<boolean>;
  readonly user?: (db: Db) => Promise<{ id: number; role: "admin" | "user" } | null>;
  /**
   * Who is reading and what they may do (pages: the request context's `authenticate` and
   * `authorize`). Default: the open-source rules over the session cookie, or over `user`.
   */
  readonly access?: Access;
  readonly orgName?: () => Promise<string | null>;
  readonly now?: () => Date;
}

export const DEFAULT_ORG_NAME = "Organization";

export async function loadDocComments(
  owner: string,
  name: string,
  path: string,
  deps: DocCommentsDeps,
): Promise<DocCommentsData> {
  try {
    const enabled = await (deps.enabled ?? commentsEnabled)();
    if (!enabled) return { status: "disabled" };
    const db = await deps.db();
    const testUser = deps.user;
    const access =
      deps.access ??
      legacyAccess(db, testUser ? async () => (await testUser(db)) as User | null : undefined);
    const user = await access.user().catch(() => null);
    if (user === null) return { status: "hidden" };
    // Admin powers in the comments section: authors' emails, moderation, posting as the org.
    const isAdmin = await access.can("comment.moderate", {
      kind: "comment",
      authorId: null,
      asOrganization: false,
    });
    const ref = { owner, name };
    const [page, counts, orgName] = await Promise.all([
      listDocComments(db, { repo: ref, path, includeEmail: isAdmin }),
      countDocComments(db, { repo: ref, path }),
      (deps.orgName ?? (() => defaultOrgName(deps.db)))().catch(() => null),
    ]);
    return {
      status: "ready",
      repo: `${owner}/${name}`,
      path,
      threads: (await Promise.all(page.threads.map((t) => threadWithPermissions(access, t)))).map(
        toThreadData,
      ),
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

async function defaultOrgName(db: DbSource): Promise<string | null> {
  return (await getBranding(await db()).catch(() => DEFAULT_BRANDING)).orgName;
}
