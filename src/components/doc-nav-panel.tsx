"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { useDocReader } from "./doc-reader";

/**
 * The docs structure and its OKF filters (spec "Docs structure column" and "Docs structure
 * panel"). One element at every size, so there is one tree state (open folders survive opening and
 * closing) and one set of ids:
 * - from `lg` (1024px) a sticky column that scrolls on its own;
 * - below it, once scripts have run, a panel that slides in from the left over a backdrop
 *   (`.doc-panel` in `globals.css`), opened by the hamburger in `DocNavBar`. Before scripts run it
 *   is a plain block after the article.
 *
 * While it is a panel and open: `role="dialog"` with `aria-modal`, focus moves to the close button,
 * Tab and Shift+Tab wrap inside, Esc / the backdrop / the close button / a document link close it, the page behind
 * does not scroll, and on close focus returns to the hamburger. Closed, it is `visibility: hidden`
 * (CSS), so it is out of the tab order and the accessibility tree. As a column it is a plain
 * landmark: no dialog role, no close button.
 */
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.closest("[hidden]") === null,
  );
}

export function DocNavPanel({ children }: { children: ReactNode }) {
  const { open, setOpen, opener, isPanel } = useDocReader();
  const sheet = useRef<HTMLDivElement>(null);
  const active = open && isPanel;

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    const panel = sheet.current;
    const button = opener.current;
    if (panel !== null) focusables(panel)[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || panel === null) return;
      const stops = focusables(panel);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) return;
      const current = document.activeElement;
      const outside = !panel.contains(current);
      if (event.shiftKey && (current === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      root.style.overflow = previousOverflow;
      button?.focus();
    };
  }, [active, setOpen, opener]);

  return (
    <div
      data-testid="doc-nav-wrap"
      data-open={active ? "true" : "false"}
      className="doc-panel min-w-0 lg:sticky lg:top-24 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto xl:row-span-1"
    >
      <div className="doc-panel__backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
      <div
        ref={sheet}
        id="doc-nav-panel"
        data-testid="doc-nav"
        role={isPanel ? "dialog" : undefined}
        aria-modal={isPanel ? "true" : undefined}
        aria-label={isPanel ? "Documentation menu" : undefined}
        className="doc-panel__sheet min-w-0"
        onClick={(event) => {
          // A document link closes the panel, including the link to the page already open (the
          // pathname does not change then). Filter chips are links too but outside the tree: they
          // keep it open.
          const link = (event.target as Element).closest("a");
          if (link?.closest('[data-testid="docs-tree"]')) setOpen(false);
        }}
      >
        <button
          type="button"
          data-testid="doc-nav-close"
          onClick={() => setOpen(false)}
          className="doc-panel__close mb-4 cursor-pointer text-sm font-medium text-foreground underline underline-offset-4 hover:text-primary"
        >
          Close
        </button>
        {children}
      </div>
    </div>
  );
}
