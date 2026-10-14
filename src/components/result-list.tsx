import Link from "next/link";

import { splitHighlights } from "@/lib/search";
import type { ResultItemData } from "@/lib/search-view";

/**
 * The search results (task 10.3, search spec "Result presentation"). Presentational: it renders
 * `ResultItemData` and has no data access.
 *
 * Everything from the repositories (title, path, tags, snippet) is untrusted and rendered as text
 * by React. The snippet is plain text with private-use highlight markers (`src/lib/snippet.ts`),
 * split into runs by `splitHighlights`; a highlighted run becomes a `<mark>` and nothing is ever
 * set as HTML. Links are not prefetched: a result list can hold 100 database-backed pages.
 *
 * Markup: an ordered list (rank matters) of `li` items; each title is an `h3` link (the page has
 * an `h1`, and a visually hidden `h2` "Results" above the list).
 */

const CHIP = "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium";

/** Text styling of a snippet. The command palette (10.4) passes its own, smaller one. */
const SNIPPET_CLASS = "text-sm break-words text-foreground";

export function Snippet({
  text,
  className = SNIPPET_CLASS,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const parts = splitHighlights(text);
  if (parts.length === 0) return null;
  return (
    <p data-testid="result-snippet" className={className}>
      {parts.map((part, index) =>
        part.highlighted ? (
          <mark
            key={index}
            className="rounded-sm bg-accent px-0.5 font-semibold text-accent-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

export function ResultItem({ item }: { readonly item: ResultItemData }) {
  const hasChips = item.type !== null || item.status !== null || item.tags.length > 0;
  return (
    <li
      data-testid="result"
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <h3 className="text-lg font-semibold break-words">
        <Link
          href={item.href}
          prefetch={false}
          data-testid="result-link"
          className="no-underline hover:underline"
        >
          {item.title}
        </Link>
      </h3>

      <div
        data-testid="result-location"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
      >
        {item.isPrivate ? (
          <span
            data-testid="private-badge"
            className={`${CHIP} bg-private-badge text-private-badge-foreground`}
          >
            Private
          </span>
        ) : null}
        <Link
          href={item.repoHref}
          prefetch={false}
          data-testid="result-repo"
          className="font-medium break-all text-link no-underline hover:underline"
        >
          {item.repoLabel}
        </Link>
        <span aria-hidden="true">/</span>
        <span data-testid="result-path" className="font-mono text-xs break-all">
          {item.path}
        </span>
      </div>

      {item.section !== null ? (
        <p data-testid="result-section" className="text-sm text-muted-foreground">
          Section: {item.section}
        </p>
      ) : null}

      <Snippet text={item.snippet} />

      {hasChips ? (
        <ul aria-label="Document metadata" className="flex flex-wrap gap-1.5">
          {item.type !== null ? (
            <li
              data-testid="result-type"
              className={`${CHIP} bg-okf-badge text-okf-badge-foreground`}
            >
              <span className="sr-only">Type: </span>
              <span className="truncate">{item.type}</span>
            </li>
          ) : null}
          {item.status !== null ? (
            <li
              data-testid="result-status"
              className={`${CHIP} border border-border bg-secondary text-secondary-foreground`}
            >
              <span className="sr-only">Status: </span>
              <span className="truncate">{item.status}</span>
            </li>
          ) : null}
          {item.tags.map((tag) => (
            <li
              key={tag}
              data-testid="result-tag"
              className={`${CHIP} border border-border text-muted-foreground`}
            >
              <span className="sr-only">Tag: </span>
              <span className="truncate">{tag}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ResultList({ items }: { readonly items: readonly ResultItemData[] }) {
  return (
    <ol data-testid="results" aria-label="Search results" className="flex flex-col gap-3">
      {items.map((item) => (
        <ResultItem key={item.key} item={item} />
      ))}
    </ol>
  );
}
