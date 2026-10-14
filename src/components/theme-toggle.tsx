"use client";

import { useTheme } from "next-themes";
import { useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

/**
 * Light / Dark / System switch for the site header (task 8.2).
 *
 * A radio group of three icon buttons. It shows the stored choice (`theme`, which can be
 * `system`), not the resolved one, so "System" stays selected while the page is dark because the
 * OS is. Keyboard: Tab enters the group on the selected option (roving tabindex); arrow keys move
 * and select, Home/End jump to the ends, as for native radios. Selecting calls `setTheme`, which
 * next-themes applies at once and persists to `localStorage`.
 *
 * Hydration: the server (and the first client render) cannot know the choice, so until mounted a
 * `ThemeTogglePlaceholder` of identical outer size is rendered. Nothing shifts when the real
 * control swaps in. Colours come from the design tokens only.
 */

export type ThemeChoice = "light" | "dark" | "system";

const OPTIONS: readonly { readonly value: ThemeChoice; readonly label: string; icon: ReactNode }[] =
  [
    { value: "light", label: "Light", icon: <SunIcon /> },
    { value: "dark", label: "Dark", icon: <MoonIcon /> },
    { value: "system", label: "System", icon: <MonitorIcon /> },
  ];

/**
 * Same box for the placeholder and the control, so swapping them causes no layout shift. Block
 * level (`flex`, not `inline-flex`): an inline box would sit on a text baseline, and an empty
 * placeholder and a control with buttons have different baselines.
 */
const GROUP = "flex h-9 w-24 shrink-0 items-center justify-around";

const subscribeNothing = () => () => undefined;
const mountedOnClient = () => true;
const mountedOnServer = () => false;

function isChoice(value: string | undefined): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

export function ThemeToggle() {
  const mounted = useSyncExternalStore(subscribeNothing, mountedOnClient, mountedOnServer);
  const { theme, setTheme } = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!mounted) return <ThemeTogglePlaceholder />;

  // No stored choice (or a stale value) means system, the documented default.
  const selected: ThemeChoice = isChoice(theme) ? theme : "system";

  function choose(index: number): void {
    const option = OPTIONS[(index + OPTIONS.length) % OPTIONS.length];
    if (option === undefined) return;
    setTheme(option.value);
    refs.current[OPTIONS.indexOf(option)]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        choose(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        choose(index - 1);
        break;
      case "Home":
        choose(0);
        break;
      case "End":
        choose(OPTIONS.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div role="radiogroup" aria-label="Theme" data-testid="theme-toggle" className={GROUP}>
      {OPTIONS.map((option, index) => {
        const checked = option.value === selected;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            title={option.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => setTheme(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded ${
              checked
                ? "text-foreground shadow-[inset_0_-2px_0_0_currentColor]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {option.icon}
          </button>
        );
      })}
    </div>
  );
}

/** Inert stand-in rendered on the server and before mount. Same size as the control. */
export function ThemeTogglePlaceholder() {
  return <div aria-hidden="true" data-testid="theme-toggle-placeholder" className={GROUP} />;
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

function SunIcon() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...ICON}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
