import { logger, errorFields } from "../log";
import type { Db } from "../db/client";
import { listRepoIds } from "../queries";
import { anonymousReposOnly } from "../queries/visibility";
import {
  DEFAULT_PUBLIC_ACCESS,
  readPublicAccessSettings,
  type PublicAccessSettings,
} from "./settings";

/**
 * Where public access stands for a tenant (public-access design decision 3): whether anything is
 * public at all, and the admin's settings. Read from the database on every call: pages and route
 * handlers are separate bundles in a Next.js server, so no in-process cache could be cleared by
 * the admin action that changes a mark, and a visitor must lose access on the very next request.
 * The cost is two small reads (one row of ids, one settings row) for a request without a session
 * to a path that may be public; a signed-in request never makes them.
 */

export interface PublicAccessState {
  /** At least one allowed repository is public, on its own or through its folder. */
  readonly anyPublic: boolean;
  readonly settings: PublicAccessSettings;
}

/** What a failed read reports: nothing public, so every anonymous request is refused. */
export const NOTHING_PUBLIC: PublicAccessState = Object.freeze({
  anyPublic: false,
  settings: DEFAULT_PUBLIC_ACCESS,
});

/**
 * The state for a tenant. Never throws: a database error or a missing table reads as nothing
 * public (fail closed) and is logged by kind only.
 */
export async function getPublicAccessState(db: () => Promise<Db>): Promise<PublicAccessState> {
  try {
    const handle = await db();
    const [ids, settings] = await Promise.all([
      listRepoIds(handle, { visibility: anonymousReposOnly }, 1),
      readPublicAccessSettings(handle),
    ]);
    return { anyPublic: ids.length > 0, settings };
  } catch (error) {
    logger.warn("public_access.read_failed", errorFields(error));
    return NOTHING_PUBLIC;
  }
}
