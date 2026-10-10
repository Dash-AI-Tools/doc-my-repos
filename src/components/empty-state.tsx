/**
 * Shown on the home page when no repository has been synced (spec "Nothing synced yet"): says
 * how to configure DocMyRepos and run the first sync, with the real variable and command names.
 * Static text; no data. The setup guide is `docs/github-app-setup.md` in the repository (not
 * linked: the app cannot know where it is hosted).
 */
const CODE =
  "rounded border border-border bg-code-background px-1.5 py-0.5 font-mono text-sm text-code-foreground";

export function EmptyState() {
  return (
    <section
      aria-labelledby="empty-heading"
      data-testid="empty-state"
      className="rounded-lg border border-border bg-card p-6 text-card-foreground"
    >
      <h2 id="empty-heading" className="text-xl font-semibold">
        Nothing synced yet
      </h2>
      <p className="mt-2 text-muted-foreground">
        No repository documentation has been synced into this portal. To get started:
      </p>
      <ol className="mt-4 list-decimal space-y-3 pl-6">
        <li>
          Create a read-only GitHub App, install it on your organization, and set{" "}
          <code className={CODE}>DATABASE_URL</code>, <code className={CODE}>GITHUB_APP_ID</code>,{" "}
          <code className={CODE}>GITHUB_APP_PRIVATE_KEY</code> (or{" "}
          <code className={CODE}>GITHUB_APP_PRIVATE_KEY_PATH</code>),{" "}
          <code className={CODE}>GITHUB_APP_INSTALLATION_ID</code>,{" "}
          <code className={CODE}>GITHUB_WEBHOOK_SECRET</code> and{" "}
          <code className={CODE}>SYNC_SECRET</code> in the server environment. The steps are in{" "}
          <code className={CODE}>docs/github-app-setup.md</code> in the repository.
        </li>
        <li>
          Optionally limit which repositories are shown in{" "}
          <code className={CODE}>docmyrepos.config.yml</code> (copy{" "}
          <code className={CODE}>docmyrepos.config.example.yml</code>). Without it, every repository
          the App can access is synced.
        </li>
        <li>
          Run the first sync:
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-code-background p-3 font-mono text-sm text-code-foreground">
            <code>
              {'curl -X POST -H "Authorization: Bearer $SYNC_SECRET" <your-app-url>/api/sync'}
            </code>
          </pre>
        </li>
        <li>Reload this page once the sync has finished.</li>
      </ol>
    </section>
  );
}
