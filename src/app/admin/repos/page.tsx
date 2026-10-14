import { RepoAccessManager } from "@/components/repo-access-manager";
import { getAdminRepos } from "@/server/admin/service";

export const dynamic = "force-dynamic";

/** Admin repo allow/block (guarded by `src/app/admin/layout.tsx`). */
export default async function AdminReposPage() {
  const repos = await getAdminRepos();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Repository access</h1>
        <p className="mt-2 text-muted-foreground">
          Blocked repositories disappear for all viewers. Their content is kept, so re-allowing
          restores them without re-syncing.
        </p>
      </div>
      <RepoAccessManager initialRepos={repos} />
    </div>
  );
}
