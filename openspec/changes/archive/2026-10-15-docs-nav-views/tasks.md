# Tasks

## 1. Path tree and preference

- [x] 1.1 Add `buildPathTree(rows, docsFolder)` and `fileLabel(path)` to `src/lib/docs-tree.ts` (same row filtering as `buildDocsTree`; `folder.index` always null; subfolders by name, then files by extension-less name via `compareTreeText`; `index.md`/`log.md` ordinary; real titles kept), and verify `docs-tree.test.ts` covers the spec's "Names and order" example, numeric ordering (`2-x` before `10-x`), `.MD`/`.mdx` stripping, rows outside the docs folder dropped, and `adjacentInTree` on the path tree giving `advanced/tuning` → `index` → `setup`
- [x] 1.2 Add the optional `titleFor` argument to `toNavTree` and verify tests that it relabels pages only (folders keep `name`), that path-tree folders come out toggle-only with no summary, and that existing `toNavTree` tests pass unchanged
- [x] 1.3 Add `NAV_VIEW_COOKIE` (`docmyrepos-nav-view`), `NavView` and `parseNavView` to `src/lib/reading-prefs.ts`, and verify unit tests: only `tree` yields Tree; missing, empty, `Tree`, `okf`, arrays and overlong values yield OKF

## 2. Server: choose the view

- [x] 2.1 Thread `view: NavView` into `loadDocPage` (`src/server/doc-page.ts`) and `loadRepoPage` (`src/server/repo-page.ts`): for an OKF repo in Tree skip `loadToc`, use `buildPathTree` for `navTree` and the pager, keep breadcrumbs from the OKF tree, and return `view` (null for non-OKF); verify against the real test database that Tree ignores a `?type=` filter and returns `toc: null`, OKF behavior is unchanged, a non-OKF repo with a Tree cookie returns `view: null` and the old tree, and the repo-space "Previous and next in the Tree view" scenario holds
- [x] 2.2 Add `src/server/nav-view-action.ts` (`"use server"` `setNavView`: parse `view`, set the cookie with `Path=/`, one year, `SameSite=Lax`, `HttpOnly`, `Secure` on https, or delete it for OKF; no redirect), and verify unit tests with a mocked `cookies()` store for set, delete and garbage input (treated as OKF, cookie deleted)
- [x] 2.3 Read the cookie with `cookies()` in `src/app/[owner]/[repo]/page.tsx` and `src/app/[owner]/[repo]/docs/[...path]/page.tsx` and pass it to the loaders, and verify the page tests for no cookie, `tree`, and an invalid value

## 3. Selector and Tree rendering

- [x] 3.1 Build `src/components/nav-view-selector.tsx` (form posting to `setNavView`; `role="group"` named "Navigation view"; two submit buttons "OKF"/"Tree" with `aria-pressed`; `aria-busy` while pending via `useFormStatus`; tokens-only underline style from design §6), and verify component tests for pressed state per view, button names and values, and that the group renders nothing extra outside the form
- [x] 3.2 Update `src/components/docs-nav-slot.tsx` to take `view`: render the selector first in the `<nav>` (above "Documentation") when `view !== null`; in Tree render the path tree with `fileLabel` titles, no filters, no "Change log" label; key `DocsTree` by view and filter query; pass `view` from both pages; verify `docs-nav-slot.test.tsx` for selector absent on non-OKF, present first on OKF, Tree showing `setup` for a doc titled "Getting started", no filter controls or labels in Tree, and OKF output unchanged
- [x] 3.3 Reveal the current entry in `DocsTree` when the tree is re-keyed by a view change, and verify a component test that the current link is scrolled into its scroller after the key changes
- [x] 3.4 Check the selector in light, dark and a branded theme at 320, 768, 1024 and 1440 px (column and slide-in panel), verify an axe pass in both themes on an OKF repo page and document page in each view, and record screenshots in the PR notes
- [x] 3.5 Document the selector in `DESIGN.md` (left navigation section: placement, underline selection, Tree labels) and the views and the `docmyrepos-nav-view` cookie in `README.md` (reading aids), and verify the documented cookie name and values match the code constants

## 4. End to end

- [x] 4.1 Add Playwright coverage on the seeded OKF repo: the selector is the first control in the left column; choosing Tree shows file-name entries in path order with no filters and keeps the current document marked; the choice persists across a reload (the server HTML already has the Tree view) and into another OKF repo; switching back restores OKF and its filters; a non-OKF repo shows no selector; Tree previous/next follow path order; on a 390 px viewport the panel stays open with focus inside after switching; with JavaScript disabled choosing Tree reloads into the Tree view; and verify `pnpm test:e2e` passes
- [x] 4.2 Run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:e2e`, and `openspec validate docs-nav-views --strict`, and verify all pass

## Workflow follow-up

- Archive the change with `/opsx:archive` after review, so the deltas merge into `docs-reader-layout` and `repo-space`.
