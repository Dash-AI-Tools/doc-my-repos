import { formFields } from "@/lib/search-params";
import { clearFiltersHref, type SearchPageView } from "@/lib/search-view";

import { FacetPanel } from "./facet-panel";
import { ResultList } from "./result-list";
import { SearchBar } from "./search-bar";
import {
  NoQueryState,
  NoResultsState,
  ResultSummary,
  SearchErrorState,
  SearchPagination,
} from "./search-parts";

/**
 * The `/search` page body (task 10.3): heading, search form and the state for `view`. Pure
 * composition of presentational components, so the page file only reads the URL and loads data.
 *
 * All state lives in the URL: the form and every link are plain GET navigations, so reload, back,
 * forward and sharing work with no client state. A new query keeps the filters (hidden inputs) and
 * starts at page 1.
 */
export function SearchView({ view }: { readonly view: SearchPageView }) {
  const { state } = view;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Search</h1>
      <SearchBar defaultValue={state.q} hiddenFields={formFields(state)} id="search-page-input" />
      {view.status === "idle" ? <NoQueryState /> : null}
      {view.status === "error" ? <SearchErrorState state={state} /> : null}
      {view.status === "ok" ? (
        <div
          className={
            view.groups.length > 0 || view.active.length > 0
              ? "grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start"
              : "grid gap-6"
          }
        >
          <FacetPanel
            groups={view.groups}
            active={view.active}
            clearHref={clearFiltersHref(state)}
          />
          <section
            aria-labelledby="results-heading"
            data-testid="search-results"
            className="flex min-w-0 flex-col gap-4"
          >
            <h2 id="results-heading" className="sr-only">
              Results
            </h2>
            <ResultSummary query={view.query} paging={view.paging} />
            {view.hits.length > 0 ? (
              <ResultList items={view.hits} />
            ) : view.paging.outOfRange ? null : (
              <NoResultsState query={view.query} state={state} />
            )}
            <SearchPagination state={state} paging={view.paging} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
