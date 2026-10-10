import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { CodeOwnersPanel } from "@/components/code-owners-panel";
import { DocsNavSlot } from "@/components/docs-nav-slot";
import { ReadmeSection } from "@/components/readme-section";
import { RepoHeader } from "@/components/repo-header";
import { RepoLoadError } from "@/components/repo-load-error";
import { repoUrl } from "@/lib/routes";
import { buildFilterQuery } from "@/lib/search-params";
import { buildTocFilterView, parseTocFilters, withFilterQuery } from "@/lib/toc-filters";
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
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One read per request, shared by `generateMetadata` and the page. Keyed by the canonical filter
 * query (`type=..&tag=..`): the OKF filters of the table of contents (tasks 11.2 and 11.3), which
 * only narrow the tree of an OKF repository.
 */
const load = cache((owner: string, repo: string, filterQuery: string) =>
  loadRepoPage(owner, repo, {}, parseTocFilters(new URLSearchParams(filterQuery))),
);

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { owner, repo } = await params;
  // The title comes from the stored repository, never from the address as typed.
  const data = await load(owner, repo, buildFilterQuery(parseTocFilters(await searchParams)));
  if (data.status === "ok") return { title: `${data.repo.owner}/${data.repo.name} · DocMyRepos` };
  if (data.status === "not_found") return { title: "Repository not found · DocMyRepos" };
  return { title: "DocMyRepos" };
}

export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { owner, repo: name } = await params;
  const filterQuery = buildFilterQuery(parseTocFilters(await searchParams));
  const data = await load(owner, name, filterQuery);
  if (data.status === "not_found") notFound();
  if (data.status === "error") return <RepoLoadError href={repoUrl(owner, name)} />;

  const { repo, readme, tree, toc, loadedAt } = data;
  if (repo.owner !== owner || repo.name !== name) {
    redirect(withFilterQuery(repoUrl(repo.owner, repo.name), filterQuery));
  }
  const basePath = repoUrl(repo.owner, repo.name);
  const filters =
    toc === null
      ? null
      : buildTocFilterView({ basePath, state: toc.state, facets: toc.facets, counts: toc.counts });
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
            filters={filters}
            okf={repo.isOkf}
          />
          <CodeOwnersPanel rules={repo.codeOwners} awaitingSync={awaitingSync} />
        </div>
      </div>
    </div>
  );
}
