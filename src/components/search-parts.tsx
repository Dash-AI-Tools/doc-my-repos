import Link from "next/link";

import {
  buildSearchUrl,
  clearFilters,
  hasFilters,
  withPage,
  type Paging,
  type SearchState,
} from "@/lib/search-params";

import { ERROR_ACTION, ErrorPanel } from "./error-panel";

/**
 * The smaller presentational pieces of the search page (task 10.3): result summary, pagination,
 * and the no-query, no-results and error states. No data access. The query is user input and is
 * only ever rendered as React text (escaped), never as HTML.
 */

const PAGE_LINK =
  "inline-flex h-10 items-center rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground no-underline hover:bg-muted hover:text-foreground";

/**
 * `“query”`: the echoed query, as text, wrapped like any long text. The quotes are real characters
 * outside the element that carries the query, so they are read out and copied with the text.
 */
export function Echo({ query }: { readonly query: string }) {
  return (
    <>
      &ldquo;
      <strong data-testid="echoed-query" className="font-semibold break-words">
        {query}
      </strong>
      &rdquo;
    </>
  );
}

/**
 * "Showing 21–40 of 87 results for “q”" in a polite live region, so a screen reader hears the
 * count when the results change.
 */
export function ResultSummary({
  query,
  paging,
}: {
  readonly query: string;
  readonly paging: Paging;
}) {
  const { total, from, to } = paging;
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="result-summary"
      // With no results the empty state below says it; the live region stays for screen readers.
      className={total === 0 ? "sr-only" : "text-sm text-muted-foreground"}
    >
      {total === 0 ? (
        <>
          No results for <Echo query={query} />
        </>
      ) : from === 0 ? (
        <>
          {total} {total === 1 ? "result" : "results"} for <Echo query={query} />, but not on this
          page
        </>
      ) : (
        <>
          Showing <span data-testid="result-range">{from === to ? from : `${from}–${to}`}</span> of{" "}
          <span data-testid="result-total">{total}</span> {total === 1 ? "result" : "results"} for{" "}
          <Echo query={query} />
        </>
      )}
    </p>
  );
}

export function SearchPagination({
  state,
  paging,
}: {
  readonly state: SearchState;
  readonly paging: Paging;
}) {
  const { prevPage, nextPage, page, lastPage, capped, outOfRange } = paging;
  if (prevPage === null && nextPage === null && !capped && !outOfRange) return null;
  return (
    <nav aria-label="Pagination" data-testid="pagination" className="flex flex-col gap-3">
      {outOfRange ? (
        <p data-testid="page-out-of-range" className="text-sm">
          Page {page} is past the last page of results.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {prevPage !== null ? (
          <Link
            href={buildSearchUrl(withPage(state, prevPage))}
            prefetch={false}
            rel="prev"
            data-testid="page-prev"
            className={PAGE_LINK}
          >
            {outOfRange ? `Go to the last page (${prevPage})` : "Previous page"}
          </Link>
        ) : null}
        {!outOfRange ? (
          <span data-testid="page-position" className="text-sm text-muted-foreground">
            Page {page} of {lastPage}
          </span>
        ) : null}
        {nextPage !== null ? (
          <Link
            href={buildSearchUrl(withPage(state, nextPage))}
            prefetch={false}
            rel="next"
            data-testid="page-next"
            className={PAGE_LINK}
          >
            Next page
          </Link>
        ) : null}
      </div>
      {capped && !outOfRange && nextPage === null ? (
        <p data-testid="results-capped" className="text-sm text-muted-foreground">
          Only the first {lastPage * state.limit} results can be browsed. Narrow the search with
          more specific words or a filter to see the rest.
        </p>
      ) : null}
    </nav>
  );
}

const CARD = "rounded-lg border border-border bg-card p-6 text-card-foreground";

/** Before any query: how to search. */
export function NoQueryState() {
  return (
    <section aria-labelledby="no-query-heading" data-testid="no-query" className={CARD}>
      <h2 id="no-query-heading" className="text-xl font-semibold">
        Search the documentation
      </h2>
      <p className="mt-2 text-muted-foreground">
        Type a word or phrase above to search the titles, headings, descriptions, tags and text of
        every synced document. Results can then be narrowed by repository and, where the documents
        declare them, by type, tag and status.
      </p>
      <ul className="mt-4 list-disc space-y-1 pl-6 text-sm">
        <li>
          <code className="rounded border border-border bg-code-background px-1.5 py-0.5 font-mono text-code-foreground">
            &quot;rate limit&quot;
          </code>{" "}
          matches the exact phrase.
        </li>
        <li>
          <code className="rounded border border-border bg-code-background px-1.5 py-0.5 font-mono text-code-foreground">
            deploy -staging
          </code>{" "}
          leaves out documents that contain the second word.
        </li>
        <li>
          <code className="rounded border border-border bg-code-background px-1.5 py-0.5 font-mono text-code-foreground">
            setup or install
          </code>{" "}
          matches either word.
        </li>
      </ul>
      <p className="mt-4 text-sm">
        Or <Link href="/">browse the repositories</Link>.
      </p>
    </section>
  );
}

/** A search that matched nothing: the query is echoed back (search spec "No results"). */
export function NoResultsState({
  query,
  state,
}: {
  readonly query: string;
  readonly state: SearchState;
}) {
  return (
    <section aria-labelledby="no-results-heading" data-testid="no-results" className={CARD}>
      <h2 id="no-results-heading" className="text-xl font-semibold">
        Nothing found for <Echo query={query} />
      </h2>
      <p className="mt-2 text-muted-foreground">
        No document matches this search. Search matches whole words only (no stemming), so{" "}
        <em>deploy</em> does not find <em>deployment</em>.
      </p>
      <ul className="mt-4 list-disc space-y-1 pl-6 text-sm">
        <li>Check the spelling.</li>
        <li>Try different or fewer words.</li>
        {hasFilters(state) ? (
          <li>
            <Link
              href={buildSearchUrl(clearFilters(state))}
              prefetch={false}
              data-testid="remove-filters"
            >
              Remove the selected filters
            </Link>{" "}
            to search every repository.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** The search could not run (database unreachable or server misconfigured). Fixed text. */
export function SearchErrorState({ state }: { readonly state: SearchState }) {
  return (
    <ErrorPanel
      title="Search is unavailable"
      testId="search-error"
      actions={
        <Link href={buildSearchUrl(state)} prefetch={false} className={ERROR_ACTION}>
          Try again
        </Link>
      }
    >
      <p>
        The portal could not run the search. The database may be unreachable or the server may be
        misconfigured. Nothing has been lost.
      </p>
      <p>
        Try again in a moment. If the problem continues, ask the administrator to check the server
        logs.
      </p>
    </ErrorPanel>
  );
}
