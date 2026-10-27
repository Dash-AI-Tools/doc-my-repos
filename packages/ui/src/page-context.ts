import { notFound, redirect } from "next/navigation";

import type { App, RequestContext } from "@docmyrepos/server";

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
