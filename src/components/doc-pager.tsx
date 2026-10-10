import Link from "next/link";

/**
 * Previous and next links at the bottom of a document page (task 9.7), in table-of-contents order.
 * Titles are third-party text: React escapes them. `rel="prev"`/`rel="next"` name the relation.
 * A missing neighbour leaves its half empty so "next" stays on the right.
 */
export interface PagerLink {
  readonly title: string;
  readonly href: string;
}

export interface DocPagerProps {
  readonly previous: PagerLink | null;
  readonly next: PagerLink | null;
}

const CARD =
  "flex h-full min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground no-underline hover:bg-muted hover:text-foreground";

export function DocPager({ previous, next }: DocPagerProps) {
  if (previous === null && next === null) return null;
  return (
    <nav
      aria-label="Previous and next pages"
      data-testid="doc-pager"
      className="grid gap-4 sm:grid-cols-2"
    >
      {previous !== null ? (
        <Link href={previous.href} prefetch={false} rel="prev" className={CARD}>
          <span className="text-xs text-muted-foreground">Previous</span>
          <span className="font-medium break-words">{previous.title}</span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      {next !== null ? (
        <Link href={next.href} prefetch={false} rel="next" className={`${CARD} sm:text-right`}>
          <span className="text-xs text-muted-foreground">Next</span>
          <span className="font-medium break-words">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
