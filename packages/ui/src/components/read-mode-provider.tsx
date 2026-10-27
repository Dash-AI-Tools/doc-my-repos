"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  READ_KEY_COOKIE,
  isReadShortcut,
  serializePreference,
  type ShortcutTarget,
} from "@docmyrepos/core/internal/reading-prefs";

import { isPaletteOpen } from "./palette-store";
import { keepPlace } from "./read-mode-place";
import { useReadModeAvailable } from "./read-mode-target";

/**
 * Read mode state for the whole page (reading-accessibility 2.3, specs "read-mode"). Mounted once
 * in the root layout, so it survives navigation between documents. It owns whether read mode is
 * on, the R key shortcut and its setting, the one window `keydown` listener, the live region that
 * announces changes, and `data-read-mode` on `<html>` (which the CSS keys on).
 *
 * Read mode can only be on where a page registered as readable (`ReadModeTarget`). When the page
 * stops being one, read mode turns off and is not remembered. It is never remembered across loads.
 */

export interface ReadModeState {
  readonly on: boolean;
  /** The page can be read in read mode (a `ReadModeTarget` is mounted). */
  readonly available: boolean;
  /** The R key shortcut is enabled (the reader's setting). */
  readonly shortcutEnabled: boolean;
  toggle(): void;
  setShortcutEnabled(enabled: boolean): void;
}

const ReadModeContext = createContext<ReadModeState | null>(null);

/**
 * What counts as an overlay for the R key and Escape: an open native dialog (the palette, the
 * Mermaid viewer), the small-screen docs panel while it is open, and anything that marks itself
 * with `data-overlay-open` (the text size panel).
 */
const OVERLAY_SELECTOR = 'dialog[open], .doc-panel[data-open="true"], [data-overlay-open="true"]';

function overlayOpen(): boolean {
  return isPaletteOpen() || document.querySelector(OVERLAY_SELECTOR) !== null;
}

/** The key target reduced to what `isReadShortcut` needs. */
function shortcutTarget(target: EventTarget | null): ShortcutTarget | null {
  if (!(target instanceof Element)) return null;
  return {
    tagName: target.tagName,
    isContentEditable: target.closest('[contenteditable]:not([contenteditable="false"])') !== null,
    role: target.getAttribute("role"),
  };
}

/** The document `<article>` (focused on entry) and the header toggle (focused on exit). */
const READ_ARTICLE = "[data-read-article]";
const READ_TOGGLE = "[data-read-toggle]";

/** `data-read-mode` on `<html>`, which the read mode CSS keys on. */
function setReadModeAttribute(on: boolean): void {
  const root = document.documentElement;
  if (on) root.dataset.readMode = "true";
  else delete root.dataset.readMode;
}

function announcement(on: boolean, shortcutEnabled: boolean): string {
  if (!on) return "Read mode off.";
  return shortcutEnabled
    ? "Read mode on. Press R or Escape to exit."
    : "Read mode on. Press Escape to exit.";
}

export function ReadModeProvider({
  initialShortcutEnabled,
  children,
}: {
  readonly initialShortcutEnabled: boolean;
  readonly children: ReactNode;
}) {
  const available = useReadModeAvailable();
  const [on, setOn] = useState(false);
  const [shortcutEnabled, setShortcut] = useState(initialShortcutEnabled);
  const [message, setMessage] = useState("");
  const announced = useRef(on);

  // Read mode does not outlive the page that allowed it: leaving a document turns it off.
  if (on && !available) setOn(false);

  // Turning on moves focus to the article (no focus ring for a programmatic focus); turning off
  // returns it to the toggle, one frame later because the toggle was hidden until now.
  const applyReadMode = useCallback((next: boolean) => {
    const article = document.querySelector<HTMLElement>(READ_ARTICLE);
    keepPlace(article, () => setReadModeAttribute(next));
    setOn(next);
    if (next) article?.focus({ preventScroll: true });
    else requestAnimationFrame(() => document.querySelector<HTMLElement>(READ_TOGGLE)?.focus());
  }, []);

  const toggle = useCallback(() => applyReadMode(!on), [applyReadMode, on]);

  const setShortcutEnabled = useCallback((enabled: boolean) => {
    setShortcut(enabled);
    document.cookie = serializePreference(READ_KEY_COOKIE, enabled ? null : "off", {
      secure: location.protocol === "https:",
    });
  }, []);

  // Announce changes of read mode only, not the first render (the ref starts at the initial value).
  useEffect(() => {
    if (announced.current === on) return;
    announced.current = on;
    setMessage(announcement(on, shortcutEnabled));
  }, [on, shortcutEnabled]);

  useEffect(() => setReadModeAttribute(on), [on]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Anything that already handled Escape has prevented the default: leave that alone.
        if (on && !event.defaultPrevented && !overlayOpen()) applyReadMode(false);
        return;
      }
      const shortcut = isReadShortcut(event, shortcutTarget(event.target), {
        enabled: shortcutEnabled,
        available,
        overlayOpen: overlayOpen(),
      });
      if (!shortcut) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [on, available, shortcutEnabled, toggle, applyReadMode]);

  const value = useMemo<ReadModeState>(
    () => ({ on, available, shortcutEnabled, toggle, setShortcutEnabled }),
    [on, available, shortcutEnabled, toggle, setShortcutEnabled],
  );

  return (
    <ReadModeContext.Provider value={value}>
      {children}
      <div role="status" className="sr-only">
        {message}
      </div>
    </ReadModeContext.Provider>
  );
}

export function useReadMode(): ReadModeState {
  const state = useContext(ReadModeContext);
  if (state === null) throw new Error("useReadMode must be used inside <ReadModeProvider>");
  return state;
}
