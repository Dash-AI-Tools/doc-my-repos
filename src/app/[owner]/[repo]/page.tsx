import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { ApiSpecList } from "@/components/api-spec-list";
import { CodeOwnersPanel } from "@/components/code-owners-panel";
import { DocNavBar } from "@/components/doc-nav-bar";
import { DocReader } from "@/components/doc-reader";
import { DocsNavSlot } from "@/components/docs-nav-slot";
import { OutlineNav } from "@/components/outline-nav";
import { ReaderGrid } from "@/components/reader-grid";
import { ReadmeSection } from "@/components/readme-section";
import { RepoHeader } from "@/components/repo-header";
import { RepoLoadError } from "@/components/repo-load-error";
import { repoUrl } from "@/lib/routes";
import { buildFilterQuery } from "@/lib/search-params";
import { buildTocFilterView, parseTocFilters, withFilterQuery } from "@/lib/toc-filters";
import type { NavView } from "@/lib/reading-prefs";
import { readNavView } from "@/server/nav-view";
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
 * Layout (spec "docs-reader-layout", the same as the document page): three columns, the docs
 * table of contents (with the OKF filters) on the left, the repository header (breadcrumb, name,
 * details), the README, the API reference list (only when the repository has specs) and the code owners in the centre, the README's headings on the right. Below `xl` the headings are a dropdown
 * in a bar under the header and below `lg` the table of contents opens from a hamburger in that
 * bar. No `<aside>`: it would be a complementary landmark nested in `<main>`.
 *
 * `/ACME/API-Service` redirects to the stored spelling, so links and bookmarks have one address.
 */
export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One read per request, shared by `generateMetadata` and the page. Keyed by the canonical filter
 * query (`type=..&tag=..`): the OKF filters of the table of contents (tasks 11.2 and 11.3), which
 * only narrow the tree of an OKF repository; and by the reader's navigation view (OKF or Tree,
 * docs-nav-views), read from its cookie so the first HTML already shows the chosen view.
 */
const load = cache((owner: string, repo: string, filterQuery: string, view: NavView) =>
  loadRepoPage(owner, repo, {}, parseTocFilters(new URLSearchParams(filterQuery)), view),
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
  const data = await load(
    owner,
    repo,
    buildFilterQuery(parseTocFilters(await searchParams)),
    await readNavView(),
  );
  if (data.status === "ok") return { title: `${data.repo.owner}/${data.repo.name}` };
  if (data.status === "not_found") return { title: "Repository not found" };
  return {};
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
  const data = await load(owner, name, filterQuery, await readNavView());
  if (data.status === "not_found") notFound();
  if (data.status === "error") return <RepoLoadError href={repoUrl(owner, name)} />;

  const { repo, readme, readmeOutline, tree, toc, view, apiSpecs, lastRun, loadedAt } = data;
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
    <DocReader>
      <DocNavBar hasOutline={readmeOutline.length > 0}>
        <OutlineNav items={readmeOutline} variant="menu" />
      </DocNavBar>
      <ReaderGrid
        outline={readmeOutline}
        nav={
          <DocsNavSlot
            docCount={repo.docCount}
            tree={tree}
            owner={repo.owner}
            repo={repo.name}
            awaitingSync={awaitingSync}
            filters={filters}
            okf={repo.isOkf}
            view={view}
            showCount
          />
        }
      >
        <RepoHeader repo={repo} lastRun={lastRun} now={loadedAt} />
        <ReadmeSection
          readme={readme}
          path={repo.readme?.path ?? null}
          awaitingSync={awaitingSync}
        />
        <ApiSpecList owner={repo.owner} repo={repo.name} specs={apiSpecs} />
        <CodeOwnersPanel rules={repo.codeOwners} awaitingSync={awaitingSync} />
      </ReaderGrid>
    </DocReader>
  );
}
