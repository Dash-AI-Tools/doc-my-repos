"use client";

import { useRef, type ReactNode } from "react";

import { useDocReader } from "./doc-reader";
import { useTrackHeight } from "./track-height";

/**
 * The bar above the document on small screens (spec "Single column on small screens"): the
 * hamburger that opens the docs structure (below `lg`, where the structure is a panel) and, as
 * `children`, the headings dropdown (below `xl`, where the headings are not a column). It sticks
 * under the site header (`--site-header-h`) and publishes its own height as `--doc-bar-h`, so the
 * page's scroll padding clears both. `hasOutline` false (a document with no headings) leaves only
 * the hamburger, so the bar is hidden from `lg`; otherwise from `xl`.
 *
 * Until scripts have run the bar is `invisible` but keeps its height: the controls cannot work
 * yet, and showing it later would shift the document down.
 */
export function DocNavBar({ hasOutline, children }: { hasOutline: boolean; children?: ReactNode }) {
  const { open, setOpen, opener, enhanced } = useDocReader();
  const bar = useRef<HTMLDivElement>(null);
  useTrackHeight(() => bar.current, "--doc-bar-h");
  return (
    <div
      ref={bar}
      data-testid="doc-bar"
      className={`sticky top-[var(--site-header-h)] z-20 flex min-h-11 items-center justify-between gap-4 border-b border-border bg-background ${
        hasOutline ? "xl:hidden" : "lg:hidden"
      } ${enhanced ? "" : "invisible"}`}
    >
      <button
        ref={opener}
        type="button"
        aria-expanded={open}
        aria-controls="doc-nav-panel"
        data-testid="doc-nav-toggle"
        onClick={() => setOpen(!open)}
        className="inline-flex h-10 cursor-pointer items-center gap-2 text-sm font-medium text-foreground hover:text-primary lg:hidden"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        Documentation
      </button>
      {children !== undefined ? <div className="ml-auto min-w-0">{children}</div> : null}
    </div>
  );
}
