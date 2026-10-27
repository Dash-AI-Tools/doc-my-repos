import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import type { AppProps } from "../bind-page";

/**
 * Guards every `/admin/*` page: login wall, then an access-denied panel for anyone the
 * `authorize` hook does not let administer the workspace.
 */
export async function AdminLayout({ app, children }: AppProps & { children: ReactNode }) {
  const ctx = await app.pageContext();
  if (ctx === null) notFound();
  const user = await ctx.user();
  if (!user) redirect("/login");
  if (!(await ctx.can("admin.manage"))) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Access denied</h1>
        <p className="text-muted-foreground">
          This area is for administrators. You are signed in as {user.email}.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
