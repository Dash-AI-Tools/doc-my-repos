# Tasks

## 1. Header height and scroll offset

- [x] 1.1 Publish the site header's height as `--site-header-h` (set in a layout effect plus a `ResizeObserver` in a small client component used by `SiteHeader`), and drive `scroll-padding-top` from it in `src/app/globals.css` with the current `5rem` / `7rem` values as the fallback; verify with a unit test that the variable follows a resized header and that `pnpm test` keeps `OutlineNav`'s reading-line tests green

## 2. Headings menu

- [x] 2.1 Move `currentHeading`, `readingLine` and the `IntersectionObserver` effect out of `src/components/outline-nav.tsx` into a shared hook (for example `useCurrentHeading(items)`), and verify the existing `outline-nav.test.tsx` cases pass unchanged
- [x] 2.2 Add the `menu` variant to `OutlineNav`: a button (`aria-expanded`, `aria-controls`) and a list under it (`max-h-[60vh] overflow-y-auto`, `data-testid="outline-menu"`) that marks the current section, closes on pick, Esc (focus back to the button), press outside and a second press of the button; the `column` variant is unchanged apart from being shown from `xl`. Verify with unit tests for open, pick, Esc, outside press, current-section marker, and that an empty outline renders nothing in either variant
- [x] 2.3 Verify a picked heading lands clear of the sticky header and the bar by asserting, in a unit test of the pick handler, that it relies on `scroll-padding-top` (no manual offset), and re-check it in the e2e task 4.4

## 3. Docs structure panel

- [x] 3.1 Create `DocNavPanel` (client): owns `open`, renders the existing `DocsNavSlot` as its body plus a close button and a backdrop below `lg`; sets `role="dialog"`, `aria-modal` and an accessible name only while below `lg` (`matchMedia`); is `invisible` when closed; Esc and backdrop close it; Tab and Shift+Tab loop inside; page scroll is locked while open; focus moves in on open and back to the opener on close. Verify with unit tests for each behavior listed
- [x] 3.2 Close the panel when the pathname changes and keep it open when only the search string changes, and close it when the viewport grows to `lg` or wider; verify with unit tests that mock `usePathname`, `useSearchParams` and `matchMedia`
- [x] 3.3 Update `DocsNavSlot` (`variant="sidebar"`): drop the `ResponsiveDetails` wrapper in favor of a heading plus the body, keep the `docs-nav`, `docs-tree` and filter test ids, and keep the filtered, empty, awaiting-sync and no-match states; verify `docs-nav-slot.test.tsx` is updated and passes, including the OKF-filter and non-OKF cases

## 4. Page assembly

- [x] 4.1 Add `DocNavBar` (client): the hamburger button (`lg:hidden`, `aria-expanded`, `aria-controls` the panel, label "Documentation") and the headings menu (`xl:hidden`), sticky at `top: var(--site-header-h)`, shown only after mount (`data-enhanced`); verify with a unit test that the bar is not shown before mount and that the button toggles the panel
- [x] 4.2 Rework the grid in `src/app/[owner]/[repo]/docs/[...path]/page.tsx`: `lg` two columns (structure left, sticky from `lg` with its own scroll), `xl` three columns (headings column right, shown from `xl`), the bar above the article, the document still first in the DOM, and the structure and headings lists inline after the article until enhanced; verify the page renders in each state (ok, OKF, no outline, awaiting sync) in the component tests and that the DOM order is breadcrumb, bar, article, pager, then the lists
- [x] 4.3 Delete `src/components/contents-jump.tsx`; delete `src/components/responsive-details.tsx` and its test if `grep` shows no remaining use; verify `pnpm typecheck && pnpm lint && pnpm test` pass
- [x] 4.4 Rewrite the layout test in `e2e/doc-page.spec.ts` for three widths: at 1440 the three columns are side by side and both rails stay in view after scrolling; at 1100 the structure is a left column and the headings are a dropdown above the title; at 375 neither is shown until used, the hamburger opens the panel, Esc closes it and focus returns, choosing a document closes it, the headings dropdown jumps to a heading that is fully visible, and the page does not scroll sideways. Verify it passes in Chromium
- [x] 4.5 Add to `e2e/okf-filters.spec.ts`: on a 375px viewport, open the panel, select a type chip, and see the panel stay open with the narrowed tree and `?type=` in the address; verify it passes
- [x] 4.6 Add axe checks of the document page at 1440, 1100 and 375 (panel open and dropdown open at 375) in light and dark to `e2e/accessibility.spec.ts`, and a no-JavaScript case at 375 asserting the document first and the structure and headings lists present below it; verify they pass
- [x] 4.7 Describe the bar, the panel and the headings menu (states, sizes, focus ring, motion) in `DESIGN.md` and `.impeccable/design.json`, and verify the design hook reports no new findings for the touched files

## 5. Integration

- [x] 5.1 Run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` and verify all pass; look at the document page at 1440, 1100 and 375 in both themes in a browser and verify no clipped text, overlap with the sticky header, or horizontal scroll
- [x] 5.2 Run `openspec validate responsive-docs-reader-layout` and verify it passes

## 6. Repository page and full width

- [x] 6.1 Return the README's `outline` from `loadRepoPage` (same `buildOutline(result.headings, anchorId)` as the document page; empty for a missing or plain-text README) and verify with unit tests for headings, no headings, missing README and plain-text fallback
- [x] 6.2 Extract `ReaderGrid` (centre column, headings column, `DocNavPanel`) from the document page, remove the `card` variant of `DocsNavSlot` in favor of a `showCount` option, and verify the document page tests and `docs-nav-slot.test.tsx` pass unchanged in behavior
- [x] 6.3 Rebuild the repository page on `DocReader`, `DocNavBar` and `ReaderGrid`: header on top, README in the centre with the code owners after it, README headings right (column from `xl`, dropdown below), tree and filters left; verify with `page.test.tsx` (DOM order header, bar, README, code owners, headings, structure; no outline for a README with no headings) and update `e2e/repo-page.spec.ts` and `e2e/doc-page.spec.ts` for the new layout
- [x] 6.4 Lift the 88rem cap for pages that contain `.doc-reader` (`site-shell` class on the header's inner container, `main` and the footer's inner container, one `:has()` rule from `lg`), widen the grid and centre the 60rem content column; verify in e2e at 2560, 1440 and 1100 that the columns reach the viewport edges with the header's padding, the content column stays 60rem and centred, and the home page keeps 88rem
- [x] 6.5 Add the repository page to the axe checks at 1440, 1100 and 375 (panel and dropdown open at 375) in both themes, update `DESIGN.md` and the sidecar for the full-width layout, and run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` and `openspec validate responsive-docs-reader-layout --strict`

## Workflow follow-up

- Archive the change after the review requirements are met.
- Regenerate the README screenshots with `scripts/screenshots.ts` after the change lands, since the document page captures change.
