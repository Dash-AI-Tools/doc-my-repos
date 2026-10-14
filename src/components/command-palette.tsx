"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { paletteRequestUrl, parsePaletteResponse, type PaletteHit } from "@/lib/palette";
import { normalizeSearchQuery, MAX_QUERY_CHARS } from "@/lib/search";
import { buildSearchUrl } from "@/lib/search-params";

import {
  closePalette,
  isPaletteOpen,
  isPaletteOpenOnServer,
  returnFocusTarget,
  subscribePalette,
  togglePalette,
} from "./palette-store";
import { SearchIcon, SHORTCUT_KEYS } from "./palette-trigger";
import { Snippet } from "./result-list";

/**
 * The global command palette (task 10.4, search spec "Global search access"): `Ctrl+K` / `⌘K`
 * anywhere opens a modal search box with live results; arrow keys and Enter navigate.
 *
 * Mounted once, in the root layout. The shortcut listener lives here (one `window` listener,
 * removed on unmount); the header trigger (`palette-trigger.tsx`) opens the same palette through
 * the store in `palette-store.ts`. The dialog is only mounted while open, so every opening starts
 * with an empty query and no request.
 *
 * Shortcut. Ctrl+K or ⌘K (no Alt or Shift) toggles the palette, also while focus is in an input,
 * textarea or contenteditable, and takes the key away from the browser (Firefox: search bar,
 * Chrome on Linux: omnibox search). Key repeat and IME composition are ignored.
 *
 * Dialog. The native `<dialog>` opened with `showModal()` (same pattern as the Mermaid viewer):
 * the page behind it is inert, focus stays inside, Esc closes. Where `showModal` is missing
 * (jsdom) the `open` attribute is set and the Esc, backdrop and Close handling does not depend on
 * the native behavior. The input is focused on open, page scroll is locked, and focus returns to
 * the element that had it (the header trigger when it opened the palette) on close. The palette
 * also closes on a route change and after a result is chosen.
 *
 * Combobox (WAI-ARIA 1.2 list autocomplete). The input is `role="combobox"` with `aria-controls`
 * (only while a list exists), `aria-expanded` and `aria-activedescendant`; focus never leaves the
 * input. The list is `role="listbox"` and each row is a real link (`<a role="option">`, so a
 * middle click or Ctrl/Cmd+click opens the document in a new tab). Down/Up move (wrapping, from
 * nothing to the first/last), Home/End jump while a row is active (otherwise they move the caret),
 * Enter opens the active row, Ctrl/Cmd+Enter opens it in a new tab, and Enter with no active row
 * opens the full results page. Tab goes to "See all results", then Close. The mouse moves the
 * active row without taking focus from the input.
 *
 * Live results. Typing is debounced (`DEBOUNCE_MS`); each new query aborts the request in flight,
 * and an answer to a superseded query is dropped (the effect that started it was cleaned up), so
 * the list can never show the answer to an older query. The previous list stays until the new one
 * arrives (`aria-busy` meanwhile). A polite live region announces the settled count. Any failure
 * (network, status, malformed body) shows "Search is unavailable" without blocking: Enter and the
 * "See all results" link still work. IME composition is not searched until it ends, and Enter or
 * arrows during composition are ignored.
 *
 * Untrusted text. Titles, paths, repository names and snippets come from third-party repositories.
 * Everything is rendered as React text; the snippet goes through `<Snippet>` (`<mark>` runs from
 * `splitHighlights`), never as HTML. Result links are accepted only if root-relative
 * (`parsePaletteResponse`). The page's CSP only needs `connect-src 'self'` for this.
 */

/** Pause after the last keystroke before searching. */
export const DEBOUNCE_MS = 150;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Ctrl+K / ⌘K, not Alt or Shift, not a repeat or composition. Layout-independent for Latin keys. */
export function isPaletteShortcut(event: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  // A Latin letter decides by itself (Dvorak: the key labelled K). Only a non-Latin layout falls
  // back to the physical key, so Ctrl+<other letter> is never taken.
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === "k" : event.code === "KeyK";
}

export function CommandPalette() {
  const open = useSyncExternalStore(subscribePalette, isPaletteOpen, isPaletteOpenOnServer);
  const pathname = usePathname();

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || !isPaletteShortcut(event)) return;
      event.preventDefault();
      if (event.repeat) return;
      togglePalette();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Close on a route change (the palette lives in the root layout, which stays mounted).
  useEffect(() => {
    closePalette();
  }, [pathname]);

  return open ? <PaletteDialog /> : null;
}

/**
 * Keeps Tab and Shift+Tab inside the dialog. A native modal dialog sends focus to the browser's own
 * controls after its last element; wrapping instead keeps it predictable and the same everywhere.
 */
function wrapFocus(event: KeyboardEvent<HTMLElement>, dialog: HTMLElement): void {
  const stops = Array.from(dialog.querySelectorAll<HTMLElement>("input, a[href], button")).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled"),
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

type Outcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "ready";
      readonly q: string;
      readonly hits: readonly PaletteHit[];
      readonly total: number;
    }
  | { readonly kind: "error"; readonly q: string };

function countText(shown: number, total: number): string {
  if (shown === 0) return "No results";
  const noun = shown === 1 && total <= 1 ? "result" : "results";
  return total > shown ? `${shown} of ${total} ${noun}` : `${shown} ${noun}`;
}

function PaletteDialog() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const reactId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const titleId = `dmr-palette-title-${reactId}`;
  const inputId = `dmr-palette-input-${reactId}`;
  const listId = `dmr-palette-list-${reactId}`;
  const backdropDown = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  const [value, setValue] = useState("");
  /** The normalized query the results are for. */
  const [q, setQ] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Open as a modal, focus the input, lock page scroll; undo all of it on unmount.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      } else {
        dialog.setAttribute("open", "");
      }
    }
    inputRef.current?.focus();
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previousOverflow;
      try {
        if (typeof dialog.close === "function" && dialog.open) dialog.close();
      } catch {
        // The element is going away anyway.
      }
      const target = returnFocusTarget();
      if (target !== null && target.isConnected) target.focus();
    };
  }, []);

  // The live search. The cleanup runs when the query changes or the palette closes: it cancels the
  // timer, aborts the request, and marks this run stale so a late answer is dropped.
  useEffect(() => {
    if (q === "") return;
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(() => {
      fetch(paletteRequestUrl(q), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("unavailable");
          const parsed = parsePaletteResponse(await response.json());
          if (parsed === null) throw new Error("unavailable");
          if (current) setOutcome({ kind: "ready", q, hits: parsed.hits, total: parsed.total });
        })
        .catch(() => {
          if (current) setOutcome({ kind: "error", q });
        });
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  // Whether the results box overflows (its content or the window size changed).
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (body === null || content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setScrollable(body.scrollHeight > body.clientHeight + 1);
    });
    observer.observe(body);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const seeAllHref = buildSearchUrl({ q });
  const loading = q !== "" && (outcome.kind === "none" || outcome.q !== q);
  const hits: readonly PaletteHit[] = q !== "" && outcome.kind === "ready" ? outcome.hits : [];
  const settledReady = q !== "" && outcome.kind === "ready" && outcome.q === q;
  const settledError = q !== "" && outcome.kind === "error" && outcome.q === q;
  const activeIndex = activeKey === null ? -1 : hits.findIndex((hit) => hit.key === activeKey);
  const hasList = hits.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    const element = document.getElementById(`${listId}-${activeIndex}`);
    if (element !== null && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, listId]);

  function commit(raw: string): void {
    const next = normalizeSearchQuery(raw);
    if (next === q) return;
    setQ(next);
    setActiveKey(null);
  }

  function go(href: string): void {
    router.push(href);
    closePalette();
  }

  function openInNewTab(href: string): void {
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function move(delta: 1 | -1): void {
    const count = hits.length;
    if (count === 0) return;
    const next =
      activeIndex < 0 ? (delta > 0 ? 0 : count - 1) : (activeIndex + delta + count) % count;
    setActiveKey(hits[next]?.key ?? null);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    const modified = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case "ArrowDown":
        if (event.altKey || modified) return;
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        if (event.altKey || modified) return;
        event.preventDefault();
        move(-1);
        return;
      case "Home":
      case "End": {
        // Only while navigating the list; otherwise they move the caret in the text.
        if (activeIndex < 0 || modified || event.shiftKey || !hasList) return;
        event.preventDefault();
        const target = event.key === "Home" ? hits[0] : hits[hits.length - 1];
        setActiveKey(target?.key ?? null);
        return;
      }
      case "Enter": {
        if (event.altKey) return;
        const hit = activeIndex >= 0 ? hits[activeIndex] : undefined;
        const href = hit?.href ?? (q === "" ? null : seeAllHref);
        if (href === null) return;
        event.preventDefault();
        if (modified) openInNewTab(href);
        else go(href);
        return;
      }
      default:
    }
  }

  /** A plain click navigates in-app and closes; modified clicks keep the browser's behavior. */
  function onLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    go(href);
  }

  const status = settledReady
    ? countText(hits.length, outcome.kind === "ready" ? outcome.total : 0)
    : settledError
      ? "Search is unavailable"
      : "";

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="command-palette"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closePalette();
        } else if (event.key === "Tab") {
          wrapFocus(event, event.currentTarget);
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        closePalette();
      }}
      onPointerDown={(event) => {
        backdropDown.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && backdropDown.current) closePalette();
        backdropDown.current = false;
      }}
      className="dmr-palette fixed inset-0 m-0 h-full max-h-none w-full max-w-none items-start justify-center bg-background/80 p-0 text-foreground backdrop:bg-transparent open:flex sm:p-6 sm:pt-[12vh]"
    >
      <div className="flex h-full w-full flex-col overflow-hidden border-border bg-popover text-popover-foreground shadow-xl sm:h-auto sm:max-h-[min(50rem,calc(100dvh-8rem))] sm:max-w-2xl sm:rounded-lg sm:border">
        <h2 id={titleId} className="sr-only">
          Quick search
        </h2>
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 text-muted-foreground">
          <SearchIcon />
          <label htmlFor={inputId} className="sr-only">
            Search documentation pages
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={hasList}
            aria-controls={hasList ? listId : undefined}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-keyshortcuts={SHORTCUT_KEYS}
            data-testid="palette-input"
            value={value}
            maxLength={MAX_QUERY_CHARS}
            placeholder="Search all documentation"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => {
              setValue(event.target.value);
              if (!composing.current) commit(event.target.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              commit(event.currentTarget.value);
            }}
            onKeyDown={onInputKeyDown}
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-popover-foreground focus-visible:outline-none"
          />
        </div>

        <div
          aria-busy={loading}
          data-testid="palette-body"
          ref={bodyRef}
          // A scrolling box must be reachable without a mouse (WCAG 2.1.1; axe
          // scrollable-region-focusable): rows are not tab stops (focus stays in the input), so
          // while the list overflows the box itself is one and the arrow keys scroll it.
          tabIndex={scrollable ? 0 : undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div ref={contentRef}>
            {q === "" ? (
              <div data-testid="palette-hint" className="px-4 py-6 text-sm text-muted-foreground">
                <p>Search the documentation of every synced repository.</p>
                <p className="mt-2 text-xs">
                  Tips: use quotes for an exact phrase, a leading minus to leave a word out, and
                  &ldquo;or&rdquo; to match either word.
                </p>
              </div>
            ) : hasList ? (
              <div
                role="listbox"
                id={listId}
                aria-label="Search results"
                data-testid="palette-results"
                className="flex flex-col p-1"
              >
                {hits.map((hit, index) => (
                  <PaletteRow
                    key={hit.key}
                    hit={hit}
                    id={optionId(index)}
                    active={index === activeIndex}
                    onActivate={() => setActiveKey(hit.key)}
                    onClick={(event) => onLinkClick(event, hit.href)}
                  />
                ))}
              </div>
            ) : settledError ? (
              <p data-testid="palette-error" className="px-4 py-6 text-sm text-muted-foreground">
                Search is unavailable. Try again in a moment, or press Enter to open the search
                page.
              </p>
            ) : settledReady ? (
              <p data-testid="palette-empty" className="px-4 py-6 text-sm text-muted-foreground">
                No results for &ldquo;{q}&rdquo;.
              </p>
            ) : (
              <p data-testid="palette-loading" className="px-4 py-6 text-sm text-muted-foreground">
                Searching&hellip;
              </p>
            )}
          </div>
        </div>

        <div role="status" aria-live="polite" data-testid="palette-status" className="sr-only">
          {status}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-2 text-sm text-muted-foreground">
          {q !== "" ? (
            <a
              href={seeAllHref}
              data-testid="palette-see-all"
              onClick={(event) => onLinkClick(event, seeAllHref)}
              className={`min-w-0 flex-1 truncate text-link no-underline hover:underline ${FOCUS_RING}`}
            >
              See all results for &quot;{q}&quot;
            </a>
          ) : (
            <span className="flex-1" />
          )}
          {loading && hasList ? (
            <span data-testid="palette-busy" aria-hidden="true" className="shrink-0 text-xs">
              Searching&hellip;
            </span>
          ) : null}
          <button
            type="button"
            onClick={closePalette}
            data-testid="palette-close"
            className={`shrink-0 cursor-pointer rounded border border-input bg-secondary px-2.5 py-1 text-sm font-medium text-secondary-foreground hover:bg-accent hover:text-accent-foreground ${FOCUS_RING}`}
          >
            Close<span className="sr-only"> search</span>
            <kbd
              aria-hidden="true"
              className="ml-2 hidden font-sans text-xs text-muted-foreground sm:inline"
            >
              Esc
            </kbd>
          </button>
        </div>
      </div>
    </dialog>
  );
}

function PaletteRow({
  hit,
  id,
  active,
  onActivate,
  onClick,
}: {
  readonly hit: PaletteHit;
  readonly id: string;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      href={hit.href}
      data-testid="palette-option"
      onMouseMove={active ? undefined : onActivate}
      // Keep keyboard focus in the input when the mouse presses a row.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`flex min-w-0 flex-col gap-0.5 rounded-md border-l px-3 py-2 text-foreground no-underline hover:text-foreground ${
        active ? "border-ring bg-muted" : "border-transparent"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span data-testid="palette-title" className="truncate text-sm font-medium">
          {hit.title}
        </span>
        {hit.isPrivate ? (
          <span
            data-testid="palette-private-badge"
            className="shrink-0 rounded-full bg-private-badge px-2 py-0.5 text-xs font-medium text-private-badge-foreground"
          >
            Private
          </span>
        ) : null}
      </span>
      <span data-testid="palette-location" className="truncate text-xs text-muted-foreground">
        {hit.repoLabel} / {hit.path}
        {hit.section !== null ? <> &middot; {hit.section}</> : null}
      </span>
      <Snippet text={hit.snippet} className="line-clamp-2 text-xs break-words text-foreground" />
    </a>
  );
}
