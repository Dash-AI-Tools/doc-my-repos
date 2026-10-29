import { notFound, redirect } from "next/navigation";

import type { App, RequestContext } from "@docmyrepos/server";
import {
  ANONYMOUS,
  MEMBER,
  anonymousMayUse,
  type PublicNeed,
  type Reader,
} from "@docmyrepos/server/internal/public-access/reader";

/**
 * The request context of the page being rendered, for a page behind the session gate. A request
 * that matches no tenant renders the not-found page: nothing about tenants, repositories or setup
 * is read or shown. Without a signed-in user, confirmed in the tenant's database
 * (`authenticate`), the page redirects to the sign-in page, as the proxy does for a missing
 * cookie: a valid cookie of a user who has since been disabled reads nothing either.
 */
export async function pageContext(app: App): Promise<RequestContext> {
  const ctx = await app.pageContext();
  if (ctx === null) notFound();
  if ((await ctx.user()) === null) redirect("/login");
  // A user the `authorize` hook does not let read the portal sees nothing of it.
  if (!(await ctx.can("content.read"))) notFound();
  return ctx;
}

/** A page's request context with who is reading it. */
export interface ReaderContext {
  readonly ctx: RequestContext;
  readonly reader: Reader;
}

/**
 * The request context of a page that a visitor who is not signed in may read when public access
 * allows (`need`: reading content, searching, or Ask). A signed-in user is a member, as with
 * `pageContext`. Without a session the visitor is anonymous only if something is public and the
 * admin allowed `need`; otherwise they are sent to sign in, exactly as `pageContext` does. A
 * request that matches no tenant renders the not-found page. Any failure to read public access
 * is "not allowed", so a page that cannot tell never shows content to an anonymous visitor.
 */
export async function readerContext(app: App, need: PublicNeed): Promise<ReaderContext> {
  const ctx = await app.pageContext();
  if (ctx === null) notFound();
  if ((await ctx.user()) !== null) {
    if (!(await ctx.can("content.read"))) notFound();
    return { ctx, reader: MEMBER };
  }
  if (!(await anonymousMayUse(ctx, need))) redirect("/login");
  return { ctx, reader: ANONYMOUS };
}

/**
 * What a page does when its repository or document cannot be shown to this reader: the not-found
 * page for a signed-in user, and the sign-in page for an anonymous visitor, so a repository that
 * is not public cannot be told from one that does not exist.
 */
export function deny(reader: Reader): never {
  if (reader.kind === "anonymous") redirect("/login");
  notFound();
}
