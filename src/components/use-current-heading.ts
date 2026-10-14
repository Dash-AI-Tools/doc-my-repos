import { useEffect, useState } from "react";

import { outlineIds, type OutlineItem } from "@/lib/outline";

const LINE = 0.15;

/**
 * The reading line, in px from the viewport top: 15% down, but never above the page's scroll
 * padding (the sticky header and the document bar), so a heading a deep link scrolled to counts as
 * the current one.
 */
function readingLine(): number {
  const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  return Math.max(window.innerHeight * LINE, pad + 4);
}

function currentHeading(ids: readonly string[]): string | null {
  const line = readingLine();
  let current: string | null = null;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el === null) continue;
    if (el.getBoundingClientRect().top <= line) current = id;
    else break;
  }
  return current;
}

/**
 * The id of the heading being read: the last one at or above the reading line. An
 * `IntersectionObserver` whose root is the top band only wakes the code when a heading crosses
 * the line (no scroll handler); each wake-up reads the heading positions again, so the answer is
 * also right after a jump to a hash or a fast scroll. `rootMargin` ignores the rest of the
 * viewport. Returns `[current, setCurrent]`: a link click sets it at once, ahead of the scroll.
 */
export function useCurrentHeading(
  items: readonly OutlineItem[],
): readonly [string | null, (id: string | null) => void] {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const ids = outlineIds(items);
    const update = () => setActive(currentHeading(ids));
    update();
    if (typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(update, {
      rootMargin: `0px 0px -${Math.max(0, window.innerHeight - readingLine())}px 0px`,
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

  return [active, setActive];
}
