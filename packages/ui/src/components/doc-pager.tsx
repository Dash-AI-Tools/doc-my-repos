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
  "group flex h-full min-w-0 flex-col gap-1 border-t border-border pt-4 text-card-foreground no-underline hover:border-foreground hover:text-foreground";

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="inline-block align-[-0.15em]"
    >
      <path d={dir === "left" ? "M19 12H5m6-6-6 6 6 6" : "M5 12h14m-6-6 6 6-6 6"} />
    </svg>
  );
}

export function DocPager({ previous, next }: DocPagerProps) {
  if (previous === null && next === null) return null;
  return (
    <nav
      aria-label="Previous and next pages"
      data-testid="doc-pager"
      className="grid gap-x-10 gap-y-4 sm:grid-cols-2"
    >
      {previous !== null ? (
        <Link href={previous.href} prefetch={false} rel="prev" className={CARD}>
          <span className="text-sm text-muted-foreground">Previous</span>
          <span className="text-lg font-bold tracking-tight break-words group-hover:text-link">
            <Arrow dir="left" /> {previous.title}
          </span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      {next !== null ? (
        <Link href={next.href} prefetch={false} rel="next" className={`${CARD} sm:text-right`}>
          <span className="text-sm text-muted-foreground">Next</span>
          <span className="text-lg font-bold tracking-tight break-words group-hover:text-link">
            {next.title} <Arrow dir="right" />
          </span>
        </Link>
      ) : null}
    </nav>
  );
}
