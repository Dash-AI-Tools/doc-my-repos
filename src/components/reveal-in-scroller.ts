/**
 * Scrolls the nearest scrolling ancestor of `el` just far enough to show it, and never the page
 * (so a long tree or outline keeps its current entry in view without moving the document).
 * Does nothing when no ancestor scrolls or `el` is already visible. Browser only.
 */
export function revealInScroller(el: HTMLElement): void {
  let box: HTMLElement | null = el.parentElement;
  while (box !== null) {
    const overflow = getComputedStyle(box).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && box.scrollHeight > box.clientHeight) {
      const boxTop = box.getBoundingClientRect().top;
      const top = el.getBoundingClientRect().top - boxTop;
      const bottom = top + el.offsetHeight;
      if (top < 0) box.scrollTop += top - 8;
      else if (bottom > box.clientHeight) box.scrollTop += bottom - box.clientHeight + 8;
      return;
    }
    box = box.parentElement;
  }
}
