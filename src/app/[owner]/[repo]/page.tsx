import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { CodeOwnersPanel } from "@/components/code-owners-panel";
import { DocsNavSlot } from "@/components/docs-nav-slot";
import { ReadmeSection } from "@/components/readme-section";
import { RepoHeader } from "@/components/repo-header";
import { RepoLoadError } from "@/components/repo-load-error";
import { repoUrl } from "@/lib/routes";
import { loadRepoPage } from "@/server/repo-page";

/**
 * Repository space `/<owner>/<repo>` (tasks 9.3 to 9.5): header, README, code owners and, in the
 * sidebar, the docs table of contents (task 9.6). Read from Postgres only
 * (never GitHub). The content changes whenever a sync finishes, so the page is rendered per
 * request.
 *
 * States: ok; not found (HTTP 404 through `notFound()`, for an unknown, hidden or malformed
 * address, see `src/server/repo-page.ts`); and the in-page error state for an unreachable database
 * or unusable configuration (HTTP 200, as on the home page). Unexpected errors go to
 * `src/app/error.tsx`.
 *
 * Layout (final): header; below it the README in the main column, and a sidebar column (stacked
 * under the README on narrow screens) with the `Documentation` navigation landmark, then the code
 * owners. No `<aside>`: it would be a complementary landmark nested in `<main>`.
 *
 * `/ACME/API-Service` redirects to the stored spelling, so links and bookmarks have one address.
 */
export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string }>;

/** One read per request, shared by `generateMetadata` and the page. */
const load = cache(loadRepoPage);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo } = await params;
  // The title comes from the stored repository, never from the address as typed.
  const data = await load(owner, repo);
  if (data.status === "ok") return { title: `${data.repo.owner}/${data.repo.name} · DocMyRepos` };
  if (data.status === "not_found") return { title: "Repository not found · DocMyRepos" };
  return { title: "DocMyRepos" };
}

export default async function RepoPage({ params }: { params: Params }) {
  const { owner, repo: name } = await params;
  const data = await load(owner, name);
  if (data.status === "not_found") notFound();
  if (data.status === "error") return <RepoLoadError href={repoUrl(owner, name)} />;

  const { repo, readme, tree, loadedAt } = data;
  if (repo.owner !== owner || repo.name !== name) redirect(repoUrl(repo.owner, repo.name));
  const awaitingSync = repo.syncStatus === "pending" || repo.lastSyncedAt === null;

  return (
    <div className="flex flex-col gap-8">
      <RepoHeader repo={repo} now={loadedAt} />
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ReadmeSection
          readme={readme}
          path={repo.readme?.path ?? null}
          awaitingSync={awaitingSync}
        />
        <div className="flex min-w-0 flex-col gap-6">
          <DocsNavSlot
            docCount={repo.docCount}
            tree={tree}
            owner={repo.owner}
            repo={repo.name}
            awaitingSync={awaitingSync}
          />
          <CodeOwnersPanel rules={repo.codeOwners} awaitingSync={awaitingSync} />
        </div>
      </div>
    </div>
  );
}
