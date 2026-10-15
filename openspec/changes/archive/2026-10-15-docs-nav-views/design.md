# Design

## Context

See proposal.md (Why) for the motivation and `specs/` for the required behavior. This section covers only the current code that shapes the approach.

- `src/lib/docs-tree.ts` `buildDocsTree(rows, docsFolder)` turns the stored document rows into a `DocsTreeFolder`. In each folder, `index.md` is lifted onto the folder (`folder.index`), the other documents follow sorted by title, `log.md` comes last, and subfolders come after the documents. `toNavTree(tree, hrefFor, labelFor)` slims this into the `NavFolder` the client tree receives. `flattenDocsTree` and `adjacentInTree` compute the pager from the same tree.
- `src/components/docs-tree.tsx` already renders a folder without an index as a toggle-only row (`href === null`). A folder that only toggles is exactly what the Tree view needs.
- `src/server/toc-data.ts` `loadToc` applies the OKF filters and builds the filtered tree, but only for OKF repositories. `src/server/doc-page.ts` computes previous/next from the unfiltered title tree and breadcrumbs from the same tree. `src/server/repo-page.ts` does the same work for the repository page.
- `src/components/docs-nav-slot.tsx` renders the `<nav aria-label="Documentation">` landmark: the label, the count, `OkfFilters`, then `DocsTree`. `DocNavPanel` wraps it as the sticky column (from `lg`) or the slide-in dialog (below `lg`). In the dialog, a click on a tree link closes the panel and anything else keeps it open.
- Reading preferences already live in cookies. `src/lib/reading-prefs.ts` holds the names and parsers, and `src/app/layout.tsx` reads them on the server with `cookies()` so there is no flash. Pages are already dynamic: they sit behind a session cookie.
- The project has no server actions yet.

## Goals / Non-Goals

**Goals:**

- One extra pure tree builder and one cookie. Everything else reuses `NavFolder`, `DocsTree`, `DocNavPanel` and `toNavTree`.
- The view is decided on the server, so the first HTML is final and the selector works without JavaScript.

**Non-Goals:**

- Listing non-Markdown files, or files outside the docs folder.
- A Tree view for repositories that are not OKF. They keep their single view (see proposal).
- Changing breadcrumbs. They describe where a document lives and keep using folder names and titles from the OKF tree in both views.
- Showing file names in the pager. Previous/next follow the Tree order but keep document titles, because the pager names the page you will read.

## Decisions

### 1. A second builder, `buildPathTree`, beside `buildDocsTree`

`buildPathTree(rows, docsFolder): DocsTreeFolder` in `src/lib/docs-tree.ts` uses the same row filtering (only rows inside the docs folder that have a route). It differs from `buildDocsTree` in three ways:

- `folder.index` is always `null`, and `index.md` / `log.md` stay ordinary child documents. This means `toNavTree` produces toggle-only folders with no summary.
- Each folder lists its subfolders first, then its files. Subfolders sort by folder name. Files sort by file name with the extension removed. Both use the existing `compareTreeText` collator, so the order is the same on server and client, and `2-setup` comes before `10-tuning` (the same numeric behavior the OKF view already has).
- Documents keep their real `title`, so `adjacentInTree` gives the pager real titles.

`flattenDocsTree` and `adjacentInTree` work on either tree unchanged. When `folder.index` is null, the flattened order is the pre-order walk: subfolders and their contents first, then files. That matches the Tree view's visual order, as in the repo-space scenario (`advanced/tuning` → `index` → `setup`).

*Alternative considered:* a `mode` parameter on `buildDocsTree`. Rejected because the two orders share almost nothing, and one builder with branches is harder to read than two short ones.

### 2. File-name labels through `toNavTree`

`toNavTree` gets an optional fourth argument, `titleFor(doc) => string`. The Tree view passes `fileLabel(path)`, the last path segment with a trailing `.md` or `.mdx` removed, matched case-insensitively the same way `routes.ts` matches them. Folder rows already show `folder.name` as stored. No `labelFor` is passed, so `log.md` gets no "Change log" label.

### 3. The view lives in one cookie and is read on the server

`src/lib/reading-prefs.ts` adds `NAV_VIEW_COOKIE = "docmyrepos-nav-view"`, the type `NavView = "okf" | "tree"`, and `parseNavView(value)`. Only the exact value `tree` means Tree. Anything else, including a missing cookie, means OKF, which follows the rule of `parseReadKey`. No cookie is set for the default: choosing OKF clears it.

The repository page and the document page (`page.tsx`) read the cookie with `cookies()` and pass the view into `loadRepoPage` / `loadDocPage`. `src/server/*` stays free of request APIs, as it is today with `filters`.

*Alternative considered:* a `?nav=tree` URL parameter. Rejected by the user in favor of a per-visitor choice that sticks across repositories.

### 4. Server loaders choose the tree once

In `loadDocPage` and `loadRepoPage`, when `repo.isOkf && view === "tree"`:

- `loadToc` is skipped, so `toc` is null. This removes the filters and makes the page ignore any filter query, as the spec requires.
- `navTree` is `buildPathTree(rows, repo.docsPath)`.
- The pager uses `adjacentInTree(navTree, found.path)`.
- Breadcrumbs still come from the OKF tree.

In every other case the behavior is unchanged. A non-OKF repository always gets the OKF code path, so a stray cookie changes nothing there. The page data gains a `view: NavView | null` field: `null` for a non-OKF repository (no selector), otherwise the active view.

### 5. Switching uses a server action in a plain form

`src/server/nav-view-action.ts` (`"use server"`) exports `setNavView(formData)`. It reads `view` with `parseNavView` and then sets the cookie (`Path=/`, one year, `SameSite=Lax`, `HttpOnly`, and `Secure` behind https), or deletes it for OKF. The action does not redirect. Next.js re-renders the current route after a cookie write in an action, so the page comes back with the new view.

- **Without JavaScript**, `<form action={setNavView}>` posts to the current URL and the response is the re-rendered page, which covers the no-JS scenario. Next's built-in Origin check covers CSRF. The action only stores a preference value from a closed set, so it needs no session check.
- **With JavaScript**, the transition keeps `DocNavPanel` mounted. The panel stays open and focus stays on the pressed button. `DocNavPanel` closes only on clicks on links inside the docs tree, and the selector buttons are not links, so the "panel stays open" scenario needs no change there.
- `DocsTree` is re-keyed by view (in addition to the filter query) so the open-folder set resets. The folders that contain the current document open again as they do today.

*Alternative considered:* write the cookie client-side with `serializePreference` and call `router.refresh()`, as the text-size control does. Rejected because the button would do nothing without JavaScript, and the layout spec requires the structure to work then. A GET route that sets the cookie and redirects was also rejected: it needs `next=` validation against open redirects, which a server action avoids.

### 6. The selector: `NavViewSelector`

The component lives in `src/components/nav-view-selector.tsx`. It is a client component only because `useFormStatus` gives a pending state. It holds no database access.

- **Markup:** a `<form>` holding a group (`role="group"`, `aria-label="Navigation view"`) of two `<button type="submit" name="view">` with values `okf` and `tree`, labeled "OKF" and "Tree", each with `aria-pressed`. Arrow-key navigation is not used, because this is not a tablist: each button submits. Pressing the active button is a no-op, and the action still runs harmlessly.
- **Placement:** `DocsNavSlot` renders it as the first child of the `<nav>`, above the "Documentation" label, and only when `view !== null`. Inside the panel it therefore sits directly under the Close button.
- **Look (DESIGN.md: rules, not boxes; selection by underline, never a filled chip):** a full-width row of two equal text buttons, 14px label weight, on a 1px Hairline bottom rule. The selected option is Ink, bold, with the 2px inset Ink underline used by the theme toggle. The unselected option is Quiet Ink, with a Tint hover fill and Ink text on hover. Height is at least 32px, so it is a comfortable touch target. It uses only tokens, so light, dark and branded headers all work. Focus is the standard 2px Signal Blue outline. While pending, the pressed button gets `aria-busy` and nothing moves.
- **Copy:** "OKF" and "Tree", with no help text. The OKF badge in the repository header already explains the term.

### 7. Tree view rendering

`DocsNavSlot` gets `view` and, in the Tree view, calls `toNavTree(tree, hrefFor, undefined, (d) => fileLabel(d.path))` on the path tree. In the Tree view, `filters` is null because the loader skipped `loadToc`, so `OkfFilters` and the no-match state are not rendered. Hrefs carry no filter query, since the query is empty. The "Expand all" and "Collapse all" controls and the auto-open rules (`OPEN_ALL_UP_TO`) apply unchanged.

## Risks / Trade-offs

- [Two orders mean a reader's "next" changes when they switch view.] → This is intended (spec). The pager always matches the list the reader sees.
- [Server-action re-render may lose the panel's scroll position.] → `DocsTree` already reveals the current entry after `currentPath` changes. Add the same reveal when the view changes, so the current document is in sight.
- [Name collisions: `setup.md` and `setup.mdx` in one folder both show as `setup`.] → Accept this. Routes already treat them as one stem (`routes.ts`), so only one of them is reachable anyway.
- [The first server action in the codebase brings CSP and deployment questions.] → Server actions need no inline script beyond Next's runtime, which already carries the nonce. The e2e no-JS test and the existing security-header tests cover regressions.
- [A filter link opened while in the Tree view looks broken, because its filters are ignored.] → Accept this as specified. Switching to OKF applies the filters still in the address.

## Migration Plan

No data or schema changes. Deploy as usual. To roll back, revert the change: an orphan `docmyrepos-nav-view` cookie is harmless and expires within a year.
