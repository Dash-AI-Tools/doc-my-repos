"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { OutlineItem } from "@/lib/outline";

import { revealInScroller } from "./reveal-in-scroller";
import { useCurrentHeading } from "./use-current-heading";

/**
 * "On this page" (task 9.7, spec "Document page navigation" and "Headings column" / "Headings
 * dropdown"): the headings of the rendered document as a nested list of links to `#id`. The server
 * builds `items` from the render result (`buildOutline`), so every `id` exists in the page.
 * Without JavaScript it is a plain list of links; after hydration it marks the section being read
 * with `aria-current="location"` (`useCurrentHeading`).
 *
 * Two presentations of the same data, both rendered by the page and shown by CSS (the hidden one
 * is `display: none`, so only one landmark exists at a time):
 * - `column` (default): a heading and the list, the right column from `xl`.
 * - `menu`: a button that opens the list under it, for the document bar below `xl`. Choosing a
 *   heading, Esc (focus back to the button), a press outside, moving focus out, or pressing the
 *   button again closes it. The list scrolls inside itself. The jump uses the page's
 *   `scroll-padding-top`, so the heading lands clear of the header and the bar.
 */
export interface OutlineNavProps {
  readonly items: readonly OutlineItem[];
  readonly variant?: "column" | "menu";
}

function OutlineList({
  items,
  active,
  top = false,
  onPick,
}: {
  items: readonly OutlineItem[];
  active: string | null;
  top?: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <ul role="list" className={top ? "border-l border-border" : "ml-3 space-y-0"}>
      {items.map((item) => {
        const current = item.id === active;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={current ? "location" : undefined}
              onClick={() => onPick(item.id)}
              className={`-ml-px block border-l py-1 pr-2 pl-3 text-sm no-underline [overflow-wrap:anywhere] hover:text-foreground ${
                current
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
            >
              {item.text}
            </a>
            {item.children.length > 0 ? (
              <OutlineList items={item.children} active={active} onPick={onPick} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function OutlineMenu({ items }: { items: readonly OutlineItem[] }) {
  const [active, setActive] = useCurrentHeading(items);
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = `outline-menu-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!nav.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const link = nav.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (link) revealInScroller(link);
  }, [open, active]);

  return (
    <nav
      ref={nav}
      aria-label="On this page"
      data-testid="outline-menu"
      className="relative min-w-0 text-card-foreground"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="group inline-flex h-10 cursor-pointer items-center gap-2 text-sm font-medium text-foreground hover:text-primary"
      >
        On this page
        <Chevron />
      </button>
      <div
        id={listId}
        hidden={!open}
        data-testid="outline-menu-list"
        className="absolute top-full right-0 z-20 mt-0.5 max-h-[60vh] w-[min(22rem,calc(100vw-2.5rem))] overflow-y-auto rounded-sm border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      >
        <OutlineList
          items={items}
          active={active}
          top
          onPick={(id) => {
            setActive(id);
            setOpen(false);
          }}
        />
      </div>
    </nav>
  );
}

function OutlineColumn({ items }: { items: readonly OutlineItem[] }) {
  const [active, setActive] = useCurrentHeading(items);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    const link = nav.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (link) revealInScroller(link);
  }, [active]);

  return (
    <nav
      ref={nav}
      aria-label="On this page"
      data-testid="outline"
      className="min-w-0 text-card-foreground"
    >
      <p className="text-base font-bold">On this page</p>
      <div className="mt-2">
        <OutlineList items={items} active={active} top onPick={setActive} />
      </div>
    </nav>
  );
}

export function OutlineNav({ items, variant = "column" }: OutlineNavProps) {
  if (items.length === 0) return null;
  return variant === "menu" ? <OutlineMenu items={items} /> : <OutlineColumn items={items} />;
}
