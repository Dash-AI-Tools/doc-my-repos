"use client";

import { useFormStatus } from "react-dom";

import type { NavView } from "@docmyrepos/core/internal/reading-prefs";
import { setNavView } from "@docmyrepos/server/internal/nav-view-action";

/**
 * The OKF / Tree switch at the top of an OKF repository's docs structure (docs-nav-views,
 * "Navigation view selector"). A plain form posting to the `setNavView` server action, so it
 * works before and without JavaScript: the response is the same page in the chosen view. With
 * JavaScript the action re-renders the route in place, so the docs panel stays open and focus
 * stays on the pressed button.
 *
 * Two submit buttons with `aria-pressed`, not a tablist: each one acts on its own (it stores a
 * preference and reloads the structure), so arrow-key roving would only hide the second button
 * from Tab. Selection is the theme toggle's 2px inset underline on a hairline rule, never a fill
 * (DESIGN.md). While the action runs the pressed button is `aria-busy`; nothing moves.
 *
 * Each label has an icon in the stroke style of the header icons: stacked layers for OKF (the
 * documents by concept), a folder tree for Tree (the repository's folders). The icons are hidden
 * from assistive technology, so the buttons are still named "OKF" and "Tree".
 */

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
  className: "shrink-0",
} as const;

function LayersIcon() {
  return (
    <svg {...ICON}>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="m2 12.65 9.17 4.16a2 2 0 0 0 1.66 0L22 12.65" />
      <path d="m2 17.65 9.17 4.16a2 2 0 0 0 1.66 0L22 17.65" />
    </svg>
  );
}

function FolderTreeIcon() {
  return (
    <svg {...ICON}>
      <path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1z" />
      <path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1z" />
      <path d="M3 5a2 2 0 0 0 2 2h3" />
      <path d="M3 3v13a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

const OPTIONS: readonly {
  readonly value: NavView;
  readonly label: string;
  readonly icon: () => React.JSX.Element;
}[] = [
  { value: "okf", label: "OKF", icon: LayersIcon },
  { value: "tree", label: "Tree", icon: FolderTreeIcon },
];

const BASE =
  "inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 px-2 text-sm transition-colors aria-busy:cursor-progress";
const SELECTED = "font-bold text-foreground shadow-[inset_0_-2px_0_0_currentColor]";
const IDLE = "font-medium text-muted-foreground hover:bg-muted hover:text-foreground";

function Options({ view }: { view: NavView }) {
  const { pending, data } = useFormStatus();
  const requested = pending ? data?.get("view") : null;
  return OPTIONS.map((option) => {
    const selected = option.value === view;
    return (
      <button
        key={option.value}
        type="submit"
        name="view"
        value={option.value}
        aria-pressed={selected}
        aria-busy={requested === option.value ? true : undefined}
        data-testid={`nav-view-${option.value}`}
        className={`${BASE} ${selected ? SELECTED : IDLE}`}
      >
        <option.icon />
        {option.label}
      </button>
    );
  });
}

export function NavViewSelector({ view }: { readonly view: NavView }) {
  return (
    <form action={setNavView} data-testid="nav-view-selector" className="mb-4">
      <div
        role="group"
        aria-label="Navigation view"
        className="grid grid-cols-2 border-b border-border"
      >
        <Options view={view} />
      </div>
    </form>
  );
}
