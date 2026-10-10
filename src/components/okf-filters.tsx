import Link from "next/link";

import { splitFacetOptions, type FacetGroup, type FacetOption } from "@/lib/search-view";
import type { TocFilterView } from "@/lib/toc-filters";

/**
 * The type, tag and status filters of the docs table of contents (tasks 11.2 and 11.3, OKF spec
 * "Filter by type"). Presentational: it renders the `TocFilterView` built by
 * `buildTocFilterView` (`src/lib/toc-filters.ts`), which the page builds only for a repository
 * that is OKF. A plain repository gets no view, so none of this renders: no chips, no wording.
 *
 * Every chip is a real link to the page's URL with that value toggled (`?type=Concept`, the same
 * grammar as `/search`), so the filters work without JavaScript, survive a reload, and a filtered
 * table of contents is a shareable URL. Chips of one group are OR-ed, groups are AND-ed. A link
 * cannot be a checkbox, so the state is carried two ways for assistive technology:
 * `aria-current="true"` and a visually hidden "selected, press to remove" text; selected chips
 * also look different (filled). Values are shown exactly as authored: `Concept` and `concept` are
 * two chips. A long group shows its first few chips (selected ones always) and the rest behind a
 * native `<details>`. Group labels are plain text, not headings: this sits in the sidebar between
 * other landmarks and a heading level here could skip one.
 */

const CHIP =
  "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium no-underline";
const CHIP_OFF =
  "border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground";
const CHIP_ON =
  "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:underline";

function Chip({ option }: { readonly option: FacetOption }) {
  return (
    <li>
      <Link
        href={option.href}
        prefetch={false}
        aria-current={option.selected ? "true" : undefined}
        data-testid="okf-filter-chip"
        data-selected={option.selected ? "true" : "false"}
        className={`${CHIP} ${option.selected ? CHIP_ON : CHIP_OFF}`}
      >
        <span className="min-w-0 break-all">{option.label}</span>
        {/* A space for the accessible name ("Runbook 3 documents"); flex items ignore it visually. */}{" "}
        <span data-testid="okf-filter-count" className="shrink-0 tabular-nums">
          {option.count}
          <span className="sr-only"> {option.count === 1 ? "document" : "documents"}</span>
        </span>
        {option.selected ? (
          <span className="sr-only">, selected, press to remove this filter</span>
        ) : null}
      </Link>
    </li>
  );
}

function Group({ group }: { readonly group: FacetGroup }) {
  const { shown, more } = splitFacetOptions(group.options);
  const labelId = `okf-filter-${group.kind}-label`;
  return (
    <div role="group" aria-labelledby={labelId} data-testid={`okf-filter-${group.kind}`}>
      <p id={labelId} className="text-xs font-semibold text-foreground">
        {group.label}
      </p>
      <ul role="list" className="mt-1 flex flex-wrap gap-1.5">
        {shown.map((option) => (
          <Chip key={option.value} option={option} />
        ))}
      </ul>
      {more.length > 0 ? (
        <details data-testid={`okf-filter-more-${group.kind}`} className="group mt-1">
          <summary className="cursor-pointer rounded-md py-1 text-xs text-link hover:underline">
            <span className="group-open:hidden">Show {more.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul role="list" className="mt-1 flex flex-wrap gap-1.5">
            {more.map((option) => (
              <Chip key={option.value} option={option} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function documentsMatchLabel(matches: number, total: number): string {
  return `${matches} of ${total} ${total === 1 ? "document" : "documents"} match`;
}

export function OkfFilters({ view }: { readonly view: TocFilterView }) {
  return (
    <div
      role="group"
      aria-label="Filter documents"
      data-testid="okf-filters"
      className="mt-3 flex flex-col gap-3"
    >
      {view.groups.map((group) => (
        <Group key={group.kind} group={group} />
      ))}
      {view.active ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
          <p role="status" data-testid="okf-filter-summary" className="text-muted-foreground">
            {documentsMatchLabel(view.matches, view.total)}
          </p>
          {
            // Nothing matches: the "No documents match" message next to the tree has the link.
            view.matches > 0 ? (
              <Link
                href={view.clearHref}
                prefetch={false}
                data-testid="okf-filter-clear"
                className="text-link"
              >
                Clear filters
              </Link>
            ) : null
          }
        </div>
      ) : null}
    </div>
  );
}
