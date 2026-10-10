"use client";

import Link from "next/link";
import { useSyncExternalStore, type MouseEvent } from "react";

import { openPalette } from "./palette-store";

/**
 * The header's way into the command palette (task 10.4): a visible "Search" field-like control
 * with the shortcut hint, and an icon-only button on small screens.
 *
 * Progressive enhancement: it is a real link to `/search`, so without JavaScript (or before
 * hydration) it is a page navigation; with JavaScript a plain click opens the palette instead.
 * Modified clicks (new tab, new window, download) keep the browser's behavior. It is a link, not
 * a second search form, so the page's own search landmark stays the only one.
 *
 * The hint chip says `Ctrl K` on the server and on the first client render, and `⌘K` on Apple
 * platforms right after mount: `useSyncExternalStore` renders the server snapshot while hydrating,
 * so the markup always matches. The chip is hidden from assistive technology (`aria-hidden`); the
 * shortcut is announced through `aria-keyshortcuts` instead.
 */

export const SHORTCUT_KEYS = "Control+K Meta+K";

const subscribeNothing = () => () => undefined;
const serverSnapshot = () => false;

function clientIsApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** True on Apple platforms, after mount; false on the server and while hydrating. */
export function useIsApplePlatform(): boolean {
  return useSyncExternalStore(subscribeNothing, clientIsApple, serverSnapshot);
}

export function shortcutLabel(apple: boolean): string {
  return apple ? "⌘K" : "Ctrl K";
}

function onClick(event: MouseEvent<HTMLAnchorElement>): void {
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
  openPalette(event.currentTarget);
}

export function PaletteTrigger() {
  const apple = useIsApplePlatform();
  return (
    <Link
      href="/search"
      prefetch={false}
      data-testid="palette-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts={SHORTCUT_KEYS}
      onClick={onClick}
      className="flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground sm:w-48 sm:justify-start sm:px-3 lg:w-64"
    >
      <SearchIcon />
      <span className="max-sm:sr-only">Search</span>
      <kbd
        aria-hidden="true"
        data-testid="palette-shortcut"
        className="ml-auto hidden rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground sm:inline-block"
      >
        {shortcutLabel(apple)}
      </kbd>
    </Link>
  );
}

export function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="shrink-0"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}
