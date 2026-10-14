# Proposal

## Why

Documentation is read for long stretches, by people with very different eyes, screens and habits. Today the document page always carries the full site chrome (header, docs tree, headings column, breadcrumbs, footer) around the text, and the text size is fixed. A reader who finds that busy, or who needs larger text, has to rely on browser zoom, which also enlarges and squeezes the chrome. The portal should offer two reading aids of its own: a distraction-free **read mode** and a user-selectable **text size**, both one click away in the top bar and, for read mode, one key away.

## What Changes

- **Read mode** on document pages:
  - A book icon button in the top bar and the **R key** toggle it. The button shows its pressed state and announces the shortcut.
  - In read mode the page shows only the document: title, description, notices, body and the previous/next links, in one centered column with a comfortable line length and generous line spacing. The top bar, footer, docs tree, headings column, document bar, breadcrumbs, source/sync row and OKF card are hidden.
  - A small floating control keeps the way out and the text size in reach: **Exit read mode** and the same text-size menu. **Esc** and **R** also exit.
  - The reader's place in the document is kept when read mode turns on or off, focus is moved deliberately, and the change is announced to screen readers.
  - Read mode is available only where there is a document to read. It is not remembered across page loads; it stays on while moving between documents.
- **Text size** for every page:
  - An **Aa** button in the top bar opens a small panel with five sizes: Small (87.5%), Default (100%), Large (112.5%), Larger (125%) and Largest (150%), relative to the browser's own default size.
  - The choice scales the whole interface, not only the document, remembered per browser in a cookie so it is applied on the first paint with no flash and also on the sign-in page. The layout reflows instead of overflowing at every size.
- **Shortcut can be turned off.** A single-letter shortcut must be switchable (WCAG 2.1.4), so the same panel has a "Press R for read mode" checkbox, on by default and remembered. The R key never fires while typing, with a modifier key held (Ctrl/Cmd+R still reloads), or while a dialog or the search palette is open.
- Not changed: the document content and its rendering, the light/dark/system theme, per-account (cross-device) preferences, colors and contrast themes, a "dyslexia" font, line-height and width controls, text-to-speech, and printing.

## Capabilities

### New Capabilities

- `read-mode`: the distraction-free reading view of a document, how it is turned on and off (top bar button, R key, Esc), what it shows, keyboard safety of the shortcut and the switch to disable it, focus, announcements and scroll position.
- `text-size`: the user-selected interface text size, the top bar control, how it is stored and applied, and that layouts keep working at every size.

### Modified Capabilities

- None. The header, theming and document page are specified in the `docmyrepos-mvp` change specs, which are not yet archived into `openspec/specs/`. These capabilities add behavior on top and do not rewrite their requirements.

## Impact

- Pure library: `src/lib/reading-prefs.ts` (size steps and allowed values, cookie names and parsing, the R-key eligibility check), unit-tested.
- Server/layout: `src/app/layout.tsx` reads the two preference cookies and renders `data-text-size` on `<html>`; no database, no API, no new environment variable, no new dependency, CSP unchanged.
- UI: new `ReadModeToggle`, `TextSizeMenu`, `ReadModeProvider` (state, shortcut, announcements, floating bar) and `ReadModeTarget` (marks a page as readable) in `src/components/`; `src/components/site-header.tsx` gains the two controls; the document page and the reader components get `data-read-hide` markers; `src/app/globals.css` gains the text-size steps, the scaled-layout tracks and the read-mode rules.
- Coordination: `responsive-docs-reader-layout`, `starred-repos` (account menu) and `org-branding` (header tokens) also edit the header and reader components. Apply order is free, but each task re-reads the files first, and the controls use the header tokens when `org-branding` is present.
- Tests: unit tests for the library and components, e2e plus axe in both themes at every text size, and a reflow check at 320 CSS px.
- Docs: `README.md` (user guide: the shortcut, text size, cookies) and `DESIGN.md` (controls, read-mode layout, text scale).
