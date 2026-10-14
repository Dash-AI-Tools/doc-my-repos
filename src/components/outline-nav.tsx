"use client";

import { useEffect, useRef, useState } from "react";

import { outlineIds, type OutlineItem } from "@/lib/outline";

import { revealInScroller } from "./reveal-in-scroller";
import { ResponsiveDetails } from "./responsive-details";

/**
 * "On this page" (task 9.7, spec "Document page navigation"): the headings of the rendered
 * document as a nested list of links to `#id`. The server builds `items` from the render result
 * (`buildOutline`), so every `id` exists in the page. Without JavaScript it is a plain list of
 * links; after hydration it marks the section being read with `aria-current="location"`.
 *
 * The current section is the last heading at or above a line 15% of the way down the
 * viewport (a heading a deep link scrolled to sits just under the top, so it is the current one). An `IntersectionObserver` whose root is that top band only wakes the code when a
 * heading crosses the line (no scroll handler); each wake-up reads the heading positions again,
 * so the answer is also right after a jump to a hash or a fast scroll. `rootMargin` ignores the
 * bottom 85% of the viewport.
 */
export interface OutlineNavProps {
  readonly items: readonly OutlineItem[];
}

const LINE = 0.15;

function currentHeading(ids: readonly string[]): string | null {
  const line = window.innerHeight * LINE;
  let current: string | null = null;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el === null) continue;
    if (el.getBoundingClientRect().top <= line) current = id;
    else break;
  }
  return current;
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
    <ul
      role="list"
      className={top ? "space-y-0.5" : "mt-0.5 ml-3 space-y-0.5 border-l border-border pl-2"}
    >
      {items.map((item) => {
        const current = item.id === active;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={current ? "location" : undefined}
              onClick={() => onPick(item.id)}
              className={`block rounded-md px-2 py-1 text-sm no-underline [overflow-wrap:anywhere] hover:bg-muted hover:text-foreground ${
                current
                  ? "bg-accent font-medium text-accent-foreground hover:bg-accent"
                  : "text-foreground"
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

export function OutlineNav({ items }: OutlineNavProps) {
  const [active, setActive] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    const ids = outlineIds(items);
    const update = () => setActive(currentHeading(ids));
    update();
    if (typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(update, {
      rootMargin: `0px 0px -${(1 - LINE) * 100}% 0px`,
    });
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el !== null) observer.observe(el);
    }
    window.addEventListener("hashchange", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", update);
    };
  }, [items]);

  // Keep the current entry visible when the sidebar scrolls on its own (a long outline).
  useEffect(() => {
    const link = nav.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (link) revealInScroller(link);
  }, [active]);

  if (items.length === 0) return null;
  return (
    <nav
      ref={nav}
      aria-label="On this page"
      data-testid="outline"
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <ResponsiveDetails summary={<span>On this page</span>}>
        <div className="mt-2">
          <OutlineList items={items} active={active} top onPick={setActive} />
        </div>
      </ResponsiveDetails>
    </nav>
  );
}
