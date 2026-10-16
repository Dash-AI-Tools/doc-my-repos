import type { Metadata } from "next";

import { SearchView } from "@/components/search-view";
import { parseSearchParams, type RawSearchParams } from "@/lib/search-params";
import { getAskState } from "@/server/ask/settings";
import { loadSearchPage } from "@/server/search-page";

/**
 * The search page (task 10.3, search spec): results, highlighted snippets, facets and paging for
 * the query in the URL, read from Postgres only. Every bit of state is in the URL
 * (`src/lib/search-params.ts`), so a result is shareable and reload, back and forward need no
 * client code. Rendered per request.
 *
 * States: no query (instructions), results, no results (query echoed back), a page past the end,
 * and error (database unreachable or server misconfigured: in-page, HTTP 200, like the home page;
 * see `src/server/search-page.ts`). An unexpected error goes to `src/app/error.tsx`.
 *
 * `searchParams` is a Promise in this version of Next.js. Search pages are an unbounded space of
 * URLs, so they are marked `noindex`.
 */
export const dynamic = "force-dynamic";

type PageSearchParams = Promise<Exclude<RawSearchParams, URLSearchParams>>;

/** Longest query shown in the document title, in characters. */
const TITLE_QUERY_CHARS = 60;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: PageSearchParams;
}): Promise<Metadata> {
  const { q } = parseSearchParams(await searchParams);
  const shown = Array.from(q).slice(0, TITLE_QUERY_CHARS).join("");
  return {
    title: q === "" ? "Search" : { absolute: `"${shown}${shown === q ? "" : "…"}" · Search` },
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ searchParams }: { searchParams: PageSearchParams }) {
  const state = parseSearchParams(await searchParams);
  const view = await loadSearchPage(state);
  // "Ask instead" opens the Ask page with this query filled in; it is never sent from here.
  const askHref =
    state.q !== "" && (await getAskState()).state === "ready"
      ? `/ask?q=${encodeURIComponent(state.q)}`
      : null;
  return <SearchView view={view} askHref={askHref} />;
}
