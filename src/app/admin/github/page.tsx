import { getAdminGithubConfig } from "@/server/admin/service";

export const dynamic = "force-dynamic";

/** Admin GitHub configuration panel: read-only status and scope, never any secrets. */
export default async function AdminGithubPage() {
  const config = await getAdminGithubConfig();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">GitHub configuration</h1>
        <p className="mt-2 text-muted-foreground">
          App credentials stay in environment variables and are never shown here. To change which
          repositories appear, edit the config file or use repository access.
        </p>
      </div>
      <dl className="flex max-w-xl flex-col gap-2">
        <div className="flex gap-2">
          <dt className="font-medium">App ID</dt>
          <dd>{config.githubAppId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">Installation ID</dt>
          <dd>{config.githubAppInstallationId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">Config file</dt>
          <dd>
            {config.configFile}
            {config.configFound ? "" : " (not present: every accessible repository is synced)"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">Scope</dt>
          <dd>
            {config.repos ? `only: ${config.repos.join(", ")}` : "all accessible repositories"}
            {config.exclude.length > 0 ? ` (excluding ${config.exclude.join(", ")})` : ""}
          </dd>
        </div>
      </dl>
    </div>
  );
}
