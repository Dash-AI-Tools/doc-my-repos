# Proposal

## Why

The document page already has a docs tree, an OKF filter group, and an "On this page" outline, but the layout only reads as three columns at 1280px and wider. Below that the outline is stacked under the tree, and on a phone both sit after the article behind a "Contents" jump link and two collapsed disclosures. A reader on a laptop-width window or a phone has to scroll past the document, or find a jump link, to move around. Navigation should be the same three parts on every screen: structure on the left, content in the middle, headings on the right, and each part one tap away when it cannot be a column.

## Changes

- **Large screens (1280px and up):** keep three columns. Left: the docs structure (folders and documents as in the repository) with the OKF type, tag and status filters for OKF repositories. Centre: the document. Right: the document's headings. Both side columns stay in view while the document scrolls.
- **Medium screens (1024px to 1279px):** two columns. The docs structure and filters stay in the left column; the headings move to a dropdown at the top of the document.
- **Small screens (below 1024px):** one column. The left column becomes a hamburger button that opens the docs structure and filters in a slide-in panel; the headings become a dropdown at the top of the document. Both controls sit in one bar that stays under the site header while the document scrolls.
- Replace the "Contents" jump link and the collapsed sidebar disclosures with these two controls.
- Keep the document first in the DOM order, work without JavaScript (the structure and headings stay reachable as plain lists), and keep both themes first-class.
- Not changed: the repository page's docs card, what the tree and outline contain, the OKF filter semantics, URLs, and search.

## Capabilities

### New Capabilities

- `docs-reader-layout`: how the document page arranges the docs structure, the content and the heading outline across screen sizes, and how the two navigation panels open, close and behave on small screens.

### Modified Capabilities

- None. The behavior lives in the `docmyrepos-mvp` change specs (`repo-space`: "Docs table of contents" and "Document page navigation"), which are not yet archived into `openspec/specs/`. This change adds a new capability that refines them and does not rewrite their requirements; the contents of the tree and the outline stay as those requirements define.

## Impact

- Code: `src/app/[owner]/[repo]/docs/[...path]/page.tsx` (grid and breakpoints), `src/components/docs-nav-slot.tsx`, `src/components/outline-nav.tsx`, `src/components/responsive-details.tsx` and `src/components/contents-jump.tsx` (replaced), plus two new client components for the slide-in panel and the headings dropdown and a small mobile bar.
- Tests: unit tests for the new components, and a rewrite of the layout test and axe passes in `e2e/doc-page.spec.ts`, plus the phone filter flow in `e2e/okf-filters.spec.ts`.
- Docs: `DESIGN.md` and its sidecar describe the new navigation components.
- No new dependencies, no data or API changes.
