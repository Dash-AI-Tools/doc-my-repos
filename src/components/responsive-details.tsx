"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A disclosure that is open on large screens and closed on small ones (task 9.7: the sidebar
 * navigation of a document page is collapsible on mobile). Rendered on the server as an open
 * `<details>`, so with no JavaScript it is simply open; after hydration it closes itself on a
 * viewport narrower than `lg` (1024px) and opens when the viewport grows past it. The `open`
 * state is not controlled by React (it is set through the DOM), so the visitor's own toggling is
 * never overwritten by a re-render.
 */
export interface ResponsiveDetailsProps {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}

const LARGE = "(min-width: 1024px)";

export function ResponsiveDetails({
  summary,
  children,
  className,
  testId,
}: ResponsiveDetailsProps) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = ref.current;
    if (details === null || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(LARGE);
    const apply = () => {
      details.open = query.matches;
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return (
    <details ref={ref} open data-testid={testId} className={`group ${className ?? ""}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-lg font-semibold [&::-webkit-details-marker]:hidden">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {summary}
      </summary>
      {children}
    </details>
  );
}
