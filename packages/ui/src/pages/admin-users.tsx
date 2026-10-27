import { UserManager } from "../components/user-manager";
import { getAdminUsers } from "@docmyrepos/server/internal/admin/service";
import type { AppProps } from "../bind-page";
import { pageContext } from "../page-context";
import { contextAccess } from "@docmyrepos/server/internal/auth/access";

/** Admin user management (guarded by `src/app/admin/layout.tsx`). */
export async function AdminUsersPage({ app }: AppProps) {
  const ctx = await pageContext(app);
  const [users, me] = await Promise.all([getAdminUsers(ctx.db, contextAccess(ctx)), ctx.user()]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Users</h1>
      <UserManager initialUsers={users} currentUserId={me?.id ?? -1} />
    </div>
  );
}
