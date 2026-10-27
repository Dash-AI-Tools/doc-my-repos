"use client";

import { TextSizeMenu } from "./text-size-menu";
import { useReadMode } from "./read-mode-provider";

/**
 * The floating reading controls shown while read mode is on (reading-accessibility 3.3, spec
 * "read-mode", "Floating exit control"): an "Exit read mode" button and the text size menu, so a
 * reader can leave or change the size without the hidden top bar. Top right, inside the safe area,
 * above the page and below the search palette. Tokens only, so both themes work.
 *
 * It is mounted in the root layout beside the provider rather than inside it: the text size menu
 * reads the provider, so the provider cannot render the menu without an import cycle.
 */
export function ReadingControls() {
  const { on, toggle } = useReadMode();
  if (!on) return null;
  return (
    <aside
      aria-label="Reading controls"
      className="fixed z-40 flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-md"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 0.75rem)",
        right: "calc(env(safe-area-inset-right, 0px) + 0.75rem)",
      }}
    >
      <button
        type="button"
        aria-label="Exit read mode"
        onClick={toggle}
        className="inline-flex h-9 cursor-pointer items-center gap-2 rounded px-2 text-sm font-medium text-foreground hover:text-primary"
      >
        <CloseIcon />
        <span className="hidden sm:inline">Exit read mode</span>
      </button>
      <TextSizeMenu />
    </aside>
  );
}

function CloseIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
