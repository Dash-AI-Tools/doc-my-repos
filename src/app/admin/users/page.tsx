import { UserManager } from "@/components/user-manager";
import { getAdminUsers } from "@/server/admin/service";

export const dynamic = "force-dynamic";

/** Admin user management (guarded by `src/app/admin/layout.tsx`). */
export default async function AdminUsersPage() {
  const users = await getAdminUsers();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Users</h1>
      <UserManager initialUsers={users} />
    </div>
  );
}
