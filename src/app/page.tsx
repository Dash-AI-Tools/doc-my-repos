import { EmptyState } from "@/components/empty-state";
import { LoadErrorState } from "@/components/load-error";
import { RepoGrid } from "@/components/repo-grid";
import { SearchBar } from "@/components/search-bar";
import { loadHome } from "@/server/home";

/**
 * Home page (task 9.2): search bar and the repository grid, read from Postgres only (never
 * GitHub). The content changes whenever a sync finishes, so the page is rendered per request;
 * there is no `loading.tsx` because the single indexed query is faster than a skeleton flash.
 *
 * States: grid, empty ("Nothing synced yet") and error (database unreachable or server
 * misconfigured; the layout stays and the response is 200, see `src/server/home.ts`). An
 * unexpected error goes to `src/app/error.tsx`.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const home = await loadHome();
  return (
    <div className="flex flex-col gap-16">
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
      {home.status === "error" ? (
        <LoadErrorState />
      ) : home.starred.length + home.repos.length === 0 ? (
        <EmptyState />
      ) : (
        <RepoGrid starred={home.starred} repos={home.repos} now={home.loadedAt} />
      )}
    </div>
  );
}
