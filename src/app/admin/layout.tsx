import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getCurrentUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

/** Guards every `/admin/*` page: login wall, then an access-denied panel for viewers. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") {
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
