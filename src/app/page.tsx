import { HomeTabs } from "@/components/home-tabs";
import { EmptyState } from "@/components/empty-state";
import { LoadErrorState } from "@/components/load-error";
import { RepoGrid } from "@/components/repo-grid";
import { SetupBanner } from "@/components/setup-banner";
import { SearchBar } from "@/components/search-bar";
import { loadHome } from "@/server/home";
import { setupNeeded } from "@/server/onboarding";

/**
 * Home page (task 9.2): search bar and the repository grid, read from Postgres only (never
 * GitHub). The content changes whenever a sync finishes, so the page is rendered per request;
 * there is no `loading.tsx` because the single indexed query is faster than a skeleton flash.
 *
 * States: grid, empty ("Nothing synced yet") and error (database unreachable or server
 * misconfigured; the layout stays and the response is 200, see `src/server/home.ts`). An
 * unexpected error goes to `src/app/error.tsx`.
 *
 * Folders are optional (repo-folders): with starred folders a tab bar (All plus one tab per
 * folder, selected by `?folder=<id>`) sits under the search bar; a `folder` value that is not a
 * tab shows All.
 */
export const dynamic = "force-dynamic";

/** The `folder` query value as a folder id, or undefined for anything else. */
function folderParam(value: string | string[] | undefined): number | undefined {
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : undefined;
}

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams?: Promise<{ folder?: string | string[] }>;
} = {}) {
  const folderId = folderParam((await searchParams)?.folder);
  const [home, setup] = await Promise.all([loadHome({}, folderId), setupNeeded()]);
  return (
    <div className="flex flex-col gap-16">
      {setup ? <SetupBanner /> : null}
      <section aria-labelledby="home-heading" className="flex max-w-3xl flex-col gap-8">
        <div>
          <h1
            id="home-heading"
            className="text-5xl leading-[1.02] font-bold tracking-[-0.035em] break-words sm:text-6xl"
          >
            Documentation portal
          </h1>
          <p className="mt-5 text-xl leading-relaxed text-muted-foreground">
            Search and browse the Markdown documentation of all your repositories in one place.
          </p>
        </div>
        <SearchBar />
      </section>
      {home.status === "ok" && home.tabs.length > 0 ? (
        <HomeTabs tabs={home.tabs} selected={home.folder?.id ?? null} />
      ) : null}
      {home.status === "error" ? (
        <LoadErrorState />
      ) : home.starred.length + home.folders.length + home.repos.length === 0 ? (
        <EmptyState />
      ) : (
        <RepoGrid
          starred={home.starred}
          folders={home.folders}
          repos={home.repos}
          folder={home.folder}
          now={home.loadedAt}
        />
      )}
    </div>
  );
}
