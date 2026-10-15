"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_COOKIE,
  TEXT_SIZE_STEPS,
  parseTextSize,
  textSizeStep,
  serializePreference,
  type TextSizeId,
} from "@/lib/reading-prefs";

import { useReadMode } from "./read-mode-provider";
import { ThemeToggle } from "./theme-toggle";

/**
 * Text size control for the top bar and the floating reading controls (reading-accessibility 1.5,
 * specs "text-size"). A disclosure, not an ARIA menu: an icon button opens a panel with a native
 * range slider over the five sizes, the read mode button, the theme buttons and the R key checkbox. The panel closes on Escape (focus back to
 * the button), on a pointer down outside, and when focus leaves it. It does not trap focus.
 *
 * The size is the `data-text-size` attribute on `<html>`, which globals.css turns into the scale.
 * Choosing a size sets the attribute and writes or clears the cookie, so the next server render
 * agrees. Every instance reads the attribute through `useSyncExternalStore`, and a choice notifies
 * all of them at once, so two instances on one page stay in agreement and a fast second click sees
 * the new state.
 *
 * Until mounted it renders a placeholder of the same size, so nothing shifts when it swaps in.
 */

const subscribeNothing = () => () => undefined;
const mountedOnClient = () => true;
const mountedOnServer = () => false;

const textSizeListeners = new Set<() => void>();

function subscribeToTextSize(onChange: () => void): () => void {
  textSizeListeners.add(onChange);
  return () => {
    textSizeListeners.delete(onChange);
  };
}

function readTextSize(): TextSizeId {
  return parseTextSize(document.documentElement.dataset.textSize);
}

/** The server cannot know the reader's choice; it renders Default, as a stored Default does. */
const serverTextSize = (): TextSizeId => DEFAULT_TEXT_SIZE;

/**
 * Applies a size at once: the attribute drives the scale, the cookie keeps it for the next page
 * load. Default removes both, so a reader who never changed it leaves no trace.
 */
function applyTextSize(id: TextSizeId): void {
  const root = document.documentElement;
  if (id === DEFAULT_TEXT_SIZE) root.removeAttribute("data-text-size");
  else root.setAttribute("data-text-size", id);
  document.cookie = serializePreference(TEXT_SIZE_COOKIE, id === DEFAULT_TEXT_SIZE ? null : id, {
    secure: location.protocol === "https:",
  });
  for (const listener of textSizeListeners) listener();
}

export function TextSizeMenu() {
  const mounted = useSyncExternalStore(subscribeNothing, mountedOnClient, mountedOnServer);
  if (!mounted) return <TextSizeMenuPlaceholder />;
  return <TextSizeDisclosure />;
}

/** Inert stand-in rendered on the server and before mount. Same size as the button. */
export function TextSizeMenuPlaceholder() {
  return (
    <div aria-hidden="true" data-testid="text-size-placeholder" className="h-9 w-9 shrink-0" />
  );
}

function TextSizeDisclosure() {
  const [open, setOpen] = useState(false);
  const size = useSyncExternalStore(subscribeToTextSize, readTextSize, serverTextSize);
  const { on, available, toggle } = useReadMode();
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const sizeIndex = TEXT_SIZE_STEPS.findIndex((step) => step.id === size);
  const step = TEXT_SIZE_STEPS[sizeIndex] ?? textSizeStep(DEFAULT_TEXT_SIZE);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: globalThis.PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape" || !open) return;
    // Handled here so the page's own Escape (read mode) does not also act on this press.
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  }

  function onBlur(event: FocusEvent<HTMLDivElement>): void {
    // Some browsers do not focus a button or slider on click, so a null target is not a departure.
    const next = event.relatedTarget as Node | null;
    if (next !== null && !wrapper.current?.contains(next)) setOpen(false);
  }

  return (
    <div
      ref={wrapper}
      className="relative"
      data-overlay-open={open ? "true" : undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={button}
        type="button"
        data-read-toggle
        aria-label="Text size and reading options"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-header-foreground hover:opacity-80"
      >
        <SlidersIcon />
      </button>

      <div
        id={panelId}
        hidden={!open}
        // The header's foreground token is re-pointed so the theme buttons read on the popover.
        style={{ "--header-foreground": "var(--popover-foreground)" } as CSSProperties}
        className="absolute top-full right-0 z-50 mt-2 grid w-64 gap-4 max-sm:fixed max-sm:inset-x-2 max-sm:top-[calc(var(--site-header-h,4rem)+0.5rem)] max-sm:w-auto rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      >
        <div className="grid gap-1.5">
          <label htmlFor={`${panelId}-size`} className="flex justify-between text-sm font-semibold">
            Text size
            <span className="font-normal text-muted-foreground">
              {step.label} ({step.percent}%)
            </span>
          </label>
          <input
            id={`${panelId}-size`}
            type="range"
            min={0}
            max={TEXT_SIZE_STEPS.length - 1}
            step={1}
            value={sizeIndex}
            aria-valuetext={`${step.label}, ${step.percent}%`}
            onChange={(event) => {
              const chosen = TEXT_SIZE_STEPS[Number(event.target.value)];
              if (chosen !== undefined) applyTextSize(chosen.id);
            }}
            className="w-full cursor-pointer accent-primary"
          />
          {/* Guides under the track, one per stop. The 8px inset is half the native thumb, so each
              dot sits under the thumb's centre at that stop. */}
          <div
            aria-hidden="true"
            data-testid="text-size-guides"
            className="flex justify-between px-2"
          >
            {TEXT_SIZE_STEPS.map((guide, index) => (
              <span
                key={guide.id}
                className={`size-1.5 rounded-full ${
                  index === sizeIndex ? "bg-primary" : "bg-muted-foreground/50"
                }`}
              />
            ))}
          </div>
        </div>

        {available ? (
          <button
            type="button"
            aria-pressed={on}
            onClick={() => {
              setOpen(false);
              toggle();
            }}
            className={`inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded border border-border px-3 text-sm font-medium ${
              on ? "bg-foreground text-background" : "hover:bg-muted"
            }`}
          >
            <BookIcon />
            Read mode
          </button>
        ) : null}

        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold">Theme</span>
          <ThemeToggle />
        </div>

        <ReadKeyCheckbox />
      </div>
    </div>
  );
}

const ICON = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

function SlidersIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg {...ICON}>
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

/**
 * The R key switch (reading-accessibility 2.6, spec "read-mode", "The shortcut can be turned off").
 * It only changes the provider's setting, which also stores it; the size is not touched, and the
 * button and Escape keep working when it is off.
 */
function ReadKeyCheckbox() {
  const { shortcutEnabled, setShortcutEnabled } = useReadMode();
  return (
    <label className="mt-3 flex cursor-pointer items-center gap-2 border-t border-border pt-3 text-sm">
      <input
        type="checkbox"
        checked={shortcutEnabled}
        onChange={(event) => setShortcutEnabled(event.target.checked)}
      />
      Press R for read mode
    </label>
  );
}
