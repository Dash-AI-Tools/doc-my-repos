# Design: Responsive docs reader layout

## Context

See `proposal.md` (Why). Observed today, in `src/app/[owner]/[repo]/docs/[...path]/page.tsx`:

- One grid: `lg` is two columns (tree on top of outline in the left column, article right), `xl` is three (`16rem | article | 14rem`), sticky at `xl` only.
- `DocsNavSlot variant="sidebar"` and `OutlineNav` each wrap their list in `ResponsiveDetails`, an open `<details>` that closes itself below 1024px through `matchMedia`. `ContentsJump` opens the tree's `<details>` and scrolls to it.
- The DOM order is breadcrumb, article, pager, outline, tree, so keyboard and screen-reader users reach the document first. `e2e/doc-page.spec.ts` asserts that order on a phone (sidebar below the article).
- The site header is sticky (`z-30`) and wraps to two rows on a phone; the page's `scroll-padding-top` is `5rem`, `7rem` under 640px, and `OutlineNav` reads it to decide the current heading.
- `src/components/command-palette.tsx` already solves "modal panel with focus containment, scroll lock and focus return" with a native `<dialog>`.

## Goals / Non-Goals

**Goals:**

- The same three parts at every size: structure (left), document (centre), headings (right); each is a column when there is room and one control when there is not.
- Both small-screen controls reachable from the top of the page and while scrolling.
- No change to what the tree, filters and outline contain, to URLs, or to the document-first DOM.

**Non-Goals:**

- Changing the tree's labels or order. It keeps document titles as labels and the existing folder/document order; the hierarchy already mirrors the repository's folders. Showing file names instead of titles is a separate decision.
- The repository page's docs card (`variant="card"`), search, and the command palette.
- Swipe gestures, resizable columns, or remembering open folders between visits.

## Decisions

1. **Breakpoints: three columns at `xl` (1280px), two at `lg`, one below.** The three-column row needs about 74rem (16rem + 60rem article measure + 14rem + two 3rem gaps) plus page padding, so a three-column layout at 1024px would squeeze the article under 20rem. At `lg` the left rail still fits and is the more valuable column (it is the one with filters), so the headings go to a dropdown there. *Alternative:* three columns from 1024px with narrower rails. Rejected: the article drops below a readable measure.

2. **One DOM instance of the structure, restyled by breakpoint.** The `docs-nav` wrapper is a static sticky column from `lg`; below `lg` the same element is a fixed, left-anchored panel (`w-[min(20rem,85vw)]`) that slides in with a backdrop. This keeps one set of ids, one tree state (open folders survive opening and closing the panel) and one landmark. *Alternative:* render the tree twice, once per layout. Rejected: duplicate ids and test ids, and the open-folder state would diverge.

3. **The panel is a client wrapper, not a native `<dialog>`.** A `<dialog>` that must also be a plain column at `lg` fights the element's `display: none` default and its modal semantics. A `DocNavPanel` client component owns `open` state, sets `role="dialog"` and `aria-modal="true"` only while it is a panel (below `lg`, through `matchMedia`), and reuses the palette's approach for the rest: a Tab/Shift+Tab loop over the panel's focusable elements, Esc to close, page scroll lock while open, and focus returned to the hamburger button on close. A closed panel is `invisible` (not just off-screen) so it leaves the tab order and the accessibility tree. *Alternative:* extract a shared focus-containment helper from the palette. Worth doing only if the diff stays small; otherwise copy the 15 lines and leave the palette untouched.

4. **Close rules.** The panel closes when the pathname changes (choosing a document), and does not close when only the search string changes (filter chips are links to the same page with `?type=`), so a visitor can combine filters. It also closes on a viewport change to `lg` and wider. The open folder set lives in `DocsTree` and is untouched by any of this.

5. **The headings dropdown is a second presentation of the same data.** `OutlineNav` gets a `variant`: `column` (today's list, now shown only from `xl`) and `menu` (a button with `aria-expanded` and `aria-controls` plus an absolutely positioned list under it, `max-h-[60vh] overflow-y-auto`, shown below `xl`). Both are rendered, each hidden by CSS at the other's sizes (`hidden xl:block` and `xl:hidden`); `display: none` removes the hidden one from the accessibility tree, so there is one landmark at a time. The current-section logic (`currentHeading`, the `IntersectionObserver`) moves into a shared hook so each instance does not carry its own copy. The menu closes on pick, Esc, press outside, and a second press of the button. *Alternative:* one instance moved with CSS `order`. Rejected: it puts the headings first in the DOM on every size, which breaks "document first" for keyboard users on large screens.

6. **The bar.** A `DocNavBar` below the breadcrumb holds the hamburger button (`lg:hidden`) and the headings menu (`xl:hidden`), sticky under the site header. The site header's height varies (one row from `sm`, two on a phone), so `SiteHeader` publishes it as a CSS variable (`--site-header-h`, set by a `ResizeObserver`) and the bar uses `top: var(--site-header-h)`. The same value feeds `scroll-padding-top`, so a heading reached from the menu is not hidden under the header and the bar; `readingLine()` in the outline logic already reads `scroll-padding-top`, so the current-section marker follows without further change. *Alternative:* hard-code `top-16` / `top-28`. Rejected: breaks the moment the header wraps differently (long email, admin link).

7. **Without JavaScript.** The bar and its controls render `hidden` and only show once the client component has mounted (a `data-enhanced` flag on the wrapper set in an effect). Until then, and with scripts off, the structure and headings render inline after the article as plain lists (today's no-JS behavior), so nothing depends on a button that cannot work. Once enhanced, the inline copies stay where CSS puts them: the structure is the panel and the headings column is shown from `xl`.

8. **Retire the old pieces.** `ContentsJump` is deleted. `ResponsiveDetails` loses its two callers; delete it if nothing else uses it (check before removing), together with its test. The `docs-nav-slot` sidebar variant no longer wraps its body in a disclosure: on a column it is a heading plus the tree, in the panel it is the panel body with a close button.

9. **Full width through the page, not the layout.** `main`, the header's inner container and the footer's all carry a shared `site-shell` class (today `max-w-[88rem]`). A page that uses `DocReader` is marked by its `.doc-reader` root, and one rule in `globals.css`, `body:has(.doc-reader) .site-shell { max-width: none }` from `lg` up, lifts the cap for all three at once, so header and columns line up. Other pages never contain `.doc-reader` and keep 88rem. The grid becomes `16rem | 1fr | 14rem` (`18rem | 1fr | 16rem` from `2xl`) and the content column is `max-w-[60rem]` centred (`justify-self-center`) in the middle track, so the line length does not grow with the monitor. *Alternative:* remove the cap everywhere. Rejected: the home list and search results would stretch across a 2560px screen. *Alternative:* a layout prop on the root layout. Rejected: the root layout does not know which page renders under it.

10. **One grid for both pages.** The grid, the headings column and the panel move into a server component `ReaderGrid` (main content as `children`, `outline` items, `nav` node for the panel); the document page and the repository page both render `DocReader`, `DocNavBar` and `ReaderGrid`. *Alternative:* copy the markup into the repository page. Rejected: the two would drift, and the responsive rules are the hard part.

11. **README headings, code owners and the count.** `loadRepoPage` returns an `outline` built from the README's render result with the same `buildOutline(headings, anchorId)` as the document page, so the ids match the injected HTML. Code owners move into the centre column after the README (they were in the sidebar; the sticky left column is for navigation and would scroll long owner lists). The `card` variant of `DocsNavSlot` is removed: the repository page uses the same column as the document page, with a `showCount` option that keeps the "N documents" line.

## Risks / Trade-offs

- [The panel and the column are one element, so a style mistake leaves the tree visible but unreachable, or vice versa] → e2e at 1440, 1100 and 375 wide asserts visibility and the tab order for each state, in both themes.
- [Sticky bar plus sticky header eat vertical space on a phone] → the bar is one compact row (about 2.75rem); checked on a 375x667 viewport, and it is the only added chrome, since it replaces the "Contents" link and two disclosures.
- [`--site-header-h` is wrong for a frame after first paint, so a deep link lands a few pixels off] → set it synchronously in a layout effect and give `scroll-padding-top` a fallback equal to today's values.
- [Hiding by CSS leaves two outline instances mounted] → the cost is two small lists and one shared observer hook; the duplicate test id is avoided by giving the menu its own (`outline-menu`).
- [A full-width header on a 2560px screen puts the wordmark and the search far apart] → accepted: the reading layout wants the width, and the header's items already sit at its two edges; the home and search pages keep the capped header (the rule only applies when a page contains `.doc-reader`).
- [`:has()` rule flashes the cap before the layout mounts] → the rule is plain CSS evaluated on the server-rendered DOM, so there is no flash.
- [`aria-modal` on an element that is a column at `lg`] → the attribute and role are applied only while the viewport is below `lg`; above it the element is a plain `nav` landmark.
- [The `e2e/doc-page.spec.ts` layout test encodes "closed disclosures on a phone"] → rewritten in the same task group as the component it covers, not left for the end.

## Migration Plan

Pure front-end change behind the existing routes: no data, config or URL changes. Ship in one PR; rollback is a revert. README screenshots are regenerated by `scripts/screenshots.ts` after the change lands (the document page captures change), not as part of it.
