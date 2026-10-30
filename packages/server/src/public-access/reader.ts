import { cache } from "react";

import type { RequestContext } from "../app/types";
import { ANONYMOUS, MEMBER, type Reader } from "../queries/visibility";

export { ANONYMOUS, MEMBER, type Reader };
import { getPublicAccessState, type PublicAccessState } from "./state";

/**
 * What an anonymous reader asks to do (public-access): read content, search, or use Ask. Search
 * and Ask are admin settings; reading needs only that something is public.
 */
export type PublicNeed = "content" | "search" | "ask";

/**
 * Who is reading this request: a signed-in user (`authenticate` returned one) or an anonymous
 * visitor. The user is the request's memoized one, so asking twice reads the database once.
 */
export async function readerOf(ctx: Pick<RequestContext, "user">): Promise<Reader> {
  return (await ctx.user()) === null ? ANONYMOUS : MEMBER;
}

/**
 * The public access state of this request's tenant, read once per request (React's `cache`, keyed
 * by the request context) however many places ask: the layout and the page both do.
 */
export const publicAccessOf: (ctx: Pick<RequestContext, "db">) => Promise<PublicAccessState> =
  cache((ctx: Pick<RequestContext, "db">) => getPublicAccessState(() => ctx.db()));

/**
 * Whether a visitor who is not signed in may do `need` on this tenant right now: something must be
 * public, and for search and Ask the admin must have allowed it. Never throws: a failed read is
 * "no" (fail closed), so every anonymous request then ends in a login redirect or 401.
 */
export async function anonymousMayUse(
  ctx: Pick<RequestContext, "db">,
  need: PublicNeed,
): Promise<boolean> {
  const { anyPublic, settings } = await publicAccessOf(ctx);
  if (!anyPublic) return false;
  if (need === "search") return settings.searchEnabled;
  if (need === "ask") return settings.askEnabled;
  return true;
}
