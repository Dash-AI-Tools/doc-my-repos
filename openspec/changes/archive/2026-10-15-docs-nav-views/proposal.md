# Proposal

## Why

The left column of an OKF repository shows a curated view: document titles sorted by title, each folder's `index.md` folded into the folder row, `log.md` tagged "Change log" and moved to the end, and type, tag and status filters on top. That view is good for reading by concept. It is bad for finding a file you know by its path, because nothing in it matches what you see on GitHub or in your editor. Readers who think in paths need a second view of the same docs that mirrors the repository as it is.

## What Changes

- Add a two-option selector, **OKF** and **Tree**, as the first thing in the left docs column (and in the slide-in docs panel below 1024px). It appears only for OKF repositories.
- **OKF** is today's navigation, unchanged: titles, title order, folder indexes, the change log label and the OKF filters. It stays the default.
- **Tree** mirrors the repository paths under the docs folder:
  - Each entry is labeled with its file or folder name. For files, the `.md` / `.mdx` extension is removed and nothing else is changed (`setup.md` → `setup`, `index.md` → `index`).
  - Each folder lists its subfolders first, then its files, each group sorted by name.
  - `index.md` and `log.md` are ordinary files. Folders are toggles only and do not link to their index.
  - There are no OKF filters, type badges or "Change log" label. Any filters in the page address are ignored while Tree is selected.
- The visitor's choice is stored in a per-browser cookie. It applies on every OKF repository page and document page, and the server renders the chosen view directly, so the page never shows the wrong view first. The choice can be changed without JavaScript.
- Previous/next links on a document page follow the order of the view being shown.
- Only synced Markdown documents are listed in both views. Images and other files are not.
- Repositories that are not OKF are unchanged: no selector and no OKF UI.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `docs-reader-layout`: The "Docs structure column" requirement gains the OKF/Tree selector for OKF repositories. New requirements cover the Tree view's labels and order, the remembered choice, and the selector inside the slide-in panel.
- `repo-space`: In "Document page navigation", previous/next links follow the order of the view being shown (OKF or Tree), not always the title order.

## Impact

- **Code**: `src/lib/docs-tree.ts` (a path-ordered tree builder next to `buildDocsTree`), `src/lib/reading-prefs.ts` (a cookie for the navigation view), `src/server/toc-data.ts` and `src/server/doc-page.ts` / `src/server/repo-page.ts` (pick the view, skip filters in Tree, compute the pager from the shown tree), `src/components/docs-nav-slot.tsx` (selector placement and Tree rendering), `src/components/docs-tree.tsx` (folders without links already work), and a new selector component.
- **No** database, sync, migration, API or configuration changes. No new dependencies.
- **Docs**: `README.md` (navigation views and the cookie) and `DESIGN.md` (the selector's look).
