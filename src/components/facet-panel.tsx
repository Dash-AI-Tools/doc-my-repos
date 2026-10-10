import Link from "next/link";

import {
  splitFacetOptions,
  type ActiveFilter,
  type FacetGroup,
  type FacetOption,
} from "@/lib/search-view";

import { ResponsiveDetails } from "./responsive-details";

/**
 * The filter panel of the search page (task 10.3, search spec "Scoped and faceted search").
 * Presentational: it renders `FacetGroup`s and `ActiveFilter`s built by `src/lib/search-view.ts`.
 *
 * Every option is a real link whose `href` is the search URL with that value toggled, so the panel
 * works without JavaScript, can be opened in a new tab, and every filtered result is a shareable
 * URL. A link cannot be a checkbox, so each one is styled as one and carries the state in two
 * ways for assistive technology: `aria-current="true"` and a visually hidden "selected, press to
 * remove" text. The visible check box is decorative.
 *
 * The groups the page passes are already limited to those with something to show, so the OKF
 * groups (type, tag, status) are simply absent for results without such values. A long group
 * shows its first `FACET_VISIBLE` (see `src/lib/search-view.ts`) options (selected ones always) and the rest behind a native
 * `<details>` ("Show more"). On small screens the whole panel is a closed disclosure.
 */

const OPTION_LINK =
  "flex min-h-8 items-start gap-2 rounded-md px-2 py-1 text-sm text-foreground no-underline hover:bg-muted hover:text-foreground";

export function FacetOptionLink({ option }: { readonly option: FacetOption }) {
  return (
    <li>
      <Link
        href={option.href}
        prefetch={false}
        aria-current={option.selected ? "true" : undefined}
        data-testid="facet-option"
        data-selected={option.selected ? "true" : "false"}
        className={OPTION_LINK}
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-input ${
            option.selected ? "bg-primary text-primary-foreground" : "bg-background"
          }`}
        >
          {option.selected ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
            >
              <path d="m5 12 5 5 9-10" />
            </svg>
          ) : null}
        </span>
        <span className="min-w-0 flex-1 break-words">{option.label}</span>
        <span data-testid="facet-count" className="shrink-0 text-muted-foreground tabular-nums">
          {option.count}
          <span className="sr-only"> {option.count === 1 ? "result" : "results"}</span>
        </span>
        {option.selected ? (
          <span className="sr-only">, selected, press to remove this filter</span>
        ) : null}
      </Link>
    </li>
  );
}

export function FacetGroupSection({ group }: { readonly group: FacetGroup }) {
  const { shown, more } = splitFacetOptions(group.options);
  const headingId = `facet-${group.kind}`;
  return (
    <section aria-labelledby={headingId} data-testid={`facet-group-${group.kind}`}>
      <h2 id={headingId} className="px-2 text-sm font-semibold text-foreground">
        {group.label}
      </h2>
      <ul className="mt-1">
        {shown.map((option) => (
          <FacetOptionLink key={option.value} option={option} />
        ))}
      </ul>
      {more.length > 0 ? (
        <details data-testid={`facet-more-${group.kind}`} className="group">
          <summary className="cursor-pointer rounded-md px-2 py-1 text-sm text-link hover:underline">
            <span className="group-open:hidden">Show {more.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul>
            {more.map((option) => (
              <FacetOptionLink key={option.value} option={option} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export interface FacetPanelProps {
  readonly groups: readonly FacetGroup[];
  readonly active: readonly ActiveFilter[];
  /** The URL with every filter removed. */
  readonly clearHref: string;
}

export function FacetPanel({ groups, active, clearHref }: FacetPanelProps) {
  if (groups.length === 0 && active.length === 0) return null;
  return (
    <aside aria-label="Filters" data-testid="facet-panel">
      <ResponsiveDetails
        testId="facet-disclosure"
        summary={
          <>
            Filters
            {active.length > 0 ? (
              <span
                data-testid="filter-count"
                className="text-base font-normal text-muted-foreground"
              >
                ({active.length}
                <span className="sr-only"> selected</span>)
              </span>
            ) : null}
          </>
        }
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="mt-3 flex flex-col gap-4">
          {active.length > 0 ? (
            <section aria-labelledby="active-filters-heading" data-testid="active-filters">
              <h2
                id="active-filters-heading"
                className="px-2 text-sm font-semibold text-foreground"
              >
                Selected filters
              </h2>
              <ul className="mt-1 flex flex-wrap gap-1.5 px-2">
                {active.map((filter) => (
                  <li key={`${filter.kind}:${filter.value}`}>
                    <Link
                      href={filter.removeHref}
                      prefetch={false}
                      data-testid="active-filter"
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground no-underline hover:bg-muted hover:text-secondary-foreground"
                    >
                      <span className="break-all">
                        <span className="font-normal">{filter.kindLabel}: </span>
                        {filter.value}
                      </span>
                      <span aria-hidden="true">&times;</span>
                      <span className="sr-only">
                        Remove filter {filter.kindLabel}: {filter.value}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-2 px-2 text-sm">
                <Link
                  href={clearHref}
                  prefetch={false}
                  data-testid="clear-filters"
                  className="text-link"
                >
                  Clear all filters
                </Link>
              </p>
            </section>
          ) : null}
          {groups.map((group) => (
            <FacetGroupSection key={group.kind} group={group} />
          ))}
        </div>
      </ResponsiveDetails>
    </aside>
  );
}
