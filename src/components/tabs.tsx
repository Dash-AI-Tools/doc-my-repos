"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern, automatic activation): arrow keys, Home and End move
 * between tabs. Every panel stays mounted and only the selected one is shown, so unsaved edits in
 * one tab survive a visit to another.
 */
export function Tabs({
  tabs,
  initial,
  label,
}: {
  readonly tabs: readonly TabSpec[];
  readonly initial: string;
  readonly label: string;
}) {
  const base = useId();
  const [selected, setSelected] = useState(
    tabs.some((t) => t.id === initial) ? initial : (tabs[0]?.id ?? ""),
  );
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: KeyboardEvent, index: number): void {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    setSelected(tab.id);
    buttons.current[tab.id]?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
        {tabs.map((tab, i) => {
          const active = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              data-testid={`tab-${tab.id}`}
              onClick={() => setSelected(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`-mb-px min-h-6 cursor-pointer border-b-2 px-4 py-2 font-medium ${
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== selected}
          className="flex flex-col gap-6"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
