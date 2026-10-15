/**
 * Keeping the reader's place when read mode turns on or off (reading-accessibility 2.4, spec
 * "read-mode", "Focus, announcements and place"). Read mode changes the layout (the side columns
 * disappear and the text reflows), so without help the paragraph being read would jump off screen.
 *
 * The first block that intersects the viewport is measured before the layout changes and again
 * after, and the page is scrolled by the difference, instantly, in the same task, so no frame shows
 * the jump. With no such block (an empty article, or nothing in view) the page is left alone.
 */

/** The blocks an anchor can be: the headings and the common body blocks, in document order. */
export const PLACE_BLOCKS = "h1, h2, h3, h4, h5, h6, p, pre, table, ul, ol, blockquote, figure";

/** Anything with a box on screen. An element in a browser; a plain object in tests. */
export interface Boxed {
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}

/** The first block that intersects the viewport, or null when none does. */
export function firstVisible<T extends Boxed>(
  blocks: readonly T[],
  viewportHeight: number,
): T | null {
  return (
    blocks.find((block) => {
      const box = block.getBoundingClientRect();
      return box.bottom > 0 && box.top < viewportHeight;
    }) ?? null
  );
}

/**
 * Runs `change` (which switches the layout) and scrolls so the block the reader was on stays where
 * it was on screen. `change` must apply synchronously, so the adjustment happens before paint.
 */
export function keepPlace(article: HTMLElement | null, change: () => void): void {
  const blocks = article === null ? [] : [...article.querySelectorAll<HTMLElement>(PLACE_BLOCKS)];
  const anchor = firstVisible(blocks, window.innerHeight);
  const before = anchor?.getBoundingClientRect().top;
  change();
  if (anchor === null || before === undefined) return;
  const delta = anchor.getBoundingClientRect().top - before;
  if (delta !== 0) window.scrollBy({ top: delta, behavior: "instant" });
}
