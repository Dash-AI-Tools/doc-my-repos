"use client";

/**
 * "Contents" on a phone or small tablet (below `lg`), where the document tree sits after the
 * article in the DOM (document first for keyboard and screen-reader users). The control opens the
 * tree's disclosure and scrolls to it, so navigation is one tap from the top of the page. Hidden
 * from `lg` up, where the tree is a visible column.
 */
export function ContentsJump() {
  function jump(): void {
    const nav = document.querySelector<HTMLElement>('[data-testid="doc-nav"]');
    if (nav === null) return;
    for (const details of nav.querySelectorAll("details")) details.open = true;
    nav.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <button
      type="button"
      onClick={jump}
      className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground underline underline-offset-4 hover:text-primary lg:hidden"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
      Contents
    </button>
  );
}
