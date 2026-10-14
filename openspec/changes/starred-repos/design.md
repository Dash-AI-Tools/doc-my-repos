## Context

See `proposal.md` for the motivation. Current state that shapes the approach:

- The home page calls `loadHome()` (`src/server/home.ts`), which calls `listRepos()` with no limit and renders one `RepoGrid`. Order is owner/name, byte-collated, with `id` as the last tiebreak.
- `repos.is_allowed` (admin allow/block) is the closest precedent: a column on `repos`, toggled by `PATCH /api/admin/repos` through `setRepoAllowed`, shown in `RepoAccessManager`, and enforced by the visibility filter in `src/server/queries/visibility.ts`.
- The sync upserts repository rows with an explicit column list (`src/server/sync/persist.ts`), so a column the sync does not name is not touched.
- The admin handlers in `src/server/admin/service.ts` own database access; routes stay thin (guarded by `src/server/queries/enforcement.test.ts`).
- The admin repos list comes from `getAdminRepos`, which reads through `listRepos` with the allow-all filter, so blocked repos are included.

## Goals / Non-Goals

**Goals:**
- A portal-wide, admin-ordered list of starred repositories, edited on the admin Repository access page.
- A Starred section on the home page with no change to the visibility rule or the card.

**Non-Goals:**
- Per-user favourites, a star control on the home card, or starring from the repo page. Each can follow later without changing this data model.
- Dragging on the home page (reordering is an admin-page action), or any change to search ranking or the command palette.

## Decisions

**1. A nullable `repos.star_position integer`; null means not starred.** One column carries both the flag and the order, so they cannot disagree, and a repository's place survives blocking and syncing because only star actions write it. Starred repositories are ordered by `star_position`, then `id` as a tiebreak. Positions are not required to be contiguous or unique: unstar just sets null, star sets `max(star_position) + 1` (or 0 for the first), and a reorder rewrites the positions to `0..n-1`. Alternatives: a boolean `is_starred` plus a separate order table (two sources of truth, more joins); a boolean plus `starred_at` (no manual order); a unique constraint on the position (makes swaps in a single update fail without deferred constraints, and buys nothing since the reorder is transactional and the tiebreak is total).

**2. Order is applied in `loadHome`, not in `listRepos`.** `listRepos` keeps its owner/name order and gains `starPosition` (and a derived `isStarred`) on `RepoSummary`. `loadHome` partitions the result: `starred` sorted by `starPosition` then `id`, `rest` in the order received. Alphabetical order of the rest and every other caller are untouched, and pagination logic does not change. Alternative: `ORDER BY star_position NULLS LAST` in `listRepos`. Rejected: other callers rely on the current order, and the page needs two sections anyway.

**3. Visibility stays the only gate.** The starred list is a subset of what `listRepos` returns through `visibleRepos`, so blocked repos never reach the home page. Their position stays in the column, so re-allowing restores the same place. No new query touches `repos` around the filter (architecture rule). The admin page reads through the same trusted allow-all path it uses today.

**4. API shape.**
- Star and unstar: extend the existing `PATCH /api/admin/repos`. The body is `{ owner, name }` plus at least one of `isAllowed` (boolean) or `isStarred` (boolean). Each present field is validated first; absent fields are left alone. A new `setRepoStarred` sits beside `setRepoAllowed` and shares one case-insensitive owner/name lookup (extracted, not copied). Starring an already starred repo is a no-op that keeps its position. Existing callers sending only `isAllowed` keep working. A body with neither field is a 400.
- Reorder: a new `PUT /api/admin/repos/starred` with body `{ repos: [{ owner, name }, ...] }`, the complete list in the wanted order. In one transaction it reads the currently starred set, compares it with the submitted set, and rewrites positions `0..n-1`. A different set (missing, extra or repeated entries against what is starred now) is a 409 and writes nothing, so a stale client cannot overwrite a concurrent change; a malformed body or an unknown repo is a 400. The response is the new ordered list. Alternatives: a `move` endpoint taking `{owner, name, toIndex}` (smaller payload, but ambiguous when the list changed underneath); `position` on the `PATCH` (the same ambiguity, and several rows to shift).
- Both go through `requireAdmin` first, like the other admin handlers.

**5. Reorder control: drag and drop with `@dnd-kit`, plus Move up / Move down buttons.** The Starred group in `RepoAccessManager` is a sortable list (`@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`, vertical list strategy, `restrictToVerticalAxis`). Each row has a drag handle button (grip icon, `aria-label="Reorder acme/handbook"`); only the handle starts a drag, so the star, Allow/Block and text keep working normally. Sensors: pointer (with a small distance threshold so a click is not a drag), touch (the handle sets `touch-action: none`, so a drag does not scroll the page), and keyboard (Space or Enter picks up, arrows move, Space or Enter drops, Escape cancels) using the sortable keyboard coordinates. dnd-kit's live-region announcements are customized to name the repository and its position ("Picked up acme/handbook, position 2 of 5", "Moved to position 1 of 5", "Dropped at position 1 of 5"). On drop, the list is reordered optimistically with `arrayMove` and the full new order is sent to `PUT /api/admin/repos/starred`; a drop on the starting place or a cancel sends nothing; a failure (including 409) restores the previous order and shows the error. Move up and Move down buttons (named after the repository, omitted at the ends of the list) share the same reorder function. They are kept on purpose: WCAG 2.2 criterion 2.5.7 (Dragging Movements) requires a single-pointer alternative to dragging, and the repo runs axe checks. "Move to top" is dropped; dragging covers it. Alternatives: native HTML5 drag and drop (no touch support and no keyboard support without writing both by hand); `react-beautiful-dnd` (unmaintained); `@hello-pangea/dnd` (maintained fork, but heavier and its keyboard model is less configurable). The dependency is client-only and only the admin page imports it, so it does not affect the home page bundle. The version is pinned at install time to a release at least two weeks old.

**6. Admin list layout.** `getAdminRepos` keeps returning every repository; `RepoAccessManager` splits it into a "Starred" group (sorted by `starPosition`, as the sortable list) and the rest (alphabetical, from the query). Each row gains a star toggle button with `aria-pressed` next to Allow/Block. Blocked starred repos stay in the starred group, marked "blocked", so they can still be dragged or unstarred.

**7. Home markup.** `RepoGrid` renders the Starred section when given a non-empty `starred` list, with its own heading (`Starred (n)`) and the same list and card markup, then the existing Repositories section for the rest. Both are `section`s labelled by their headings. The Repositories count reflects only the non-starred rest. When `rest` is empty, the Repositories section is omitted so it does not read as an empty list; the empty state still shows only when there are no repositories at all (`starred.length + rest.length === 0`).

**8. Account menu: a disclosure, not an ARIA menu.** A new client component `AccountMenu` replaces the inline email span, the `LogoutButton` and the `Admin` nav link in `SiteHeader`; `SiteHeader` stays a server component and passes `{ email, role }`. The trigger is a button showing the email (`max-w` with `truncate` below `sm`, full email in `title` and in the accessible name, a chevron that turns when open), `aria-expanded` and `aria-controls`. The panel is a plain list of links plus a Sign out button, right-aligned under the trigger, Paper background, Hairline border, 2px corners, no shadow, `min-w-56` and `max-w-[calc(100vw-2rem)]` so it stays inside a phone viewport. It follows the same popover style as the document page's headings dropdown. Alternatives: `role="menu"` with `menuitem`s (requires roving focus, arrow keys and type-ahead to be correct; a half-implemented ARIA menu is worse than none, and these are ordinary links); a native `<details>` (works without JavaScript, but gives no Escape, outside-click or focus return, and Sign out needs JavaScript anyway). Behaviour: Escape closes and returns focus to the trigger; a `pointerdown` outside closes; activating a link or a route change (`usePathname`) closes; Tab moves through the items in order. Items for admins: Administration (`/admin`), Users, Repository access, GitHub configuration, each with `aria-current="page"` when the path matches (`usePathname`); then a Hairline rule and Sign out (the existing `POST /api/auth/logout`, then `router.push('/login')` and `router.refresh()`, moved from `LogoutButton`, which is deleted). A viewer's menu is Sign out only, so the email is a button for everyone and the bar behaves the same for all roles. The menu renders nothing when `user` is null. The header's right cluster is search, theme toggle, account button; the email is no longer `xl`-only, which is why it truncates. Nothing here is access control: `/admin/*` stays guarded by `src/proxy.ts` and `AdminLayout`, and the admin APIs by `requireAdmin`; the link list is derived from the role only to avoid showing viewers links they cannot use.

## Risks / Trade-offs

- [A sync or future upsert rewrites the column] → The sync names its columns explicitly; a persistence test asserts a starred repo keeps its star and place after a sync that updates it.
- [Two admins reorder at once] → The reorder requires the exact starred set and runs in a transaction, so the second submit gets a 409 and the UI asks them to reload; last writer wins only when the set is unchanged, which is acceptable for an ordering.
- [Position gaps or duplicates after unstar or a bug] → Reads tolerate them (order by position, then id) and every reorder normalizes to `0..n-1`; tests cover unstar in the middle, then star.
- [Drag and drop is fiddly on touch screens and for assistive technology] → The handle is the only drag target with `touch-action: none`, the keyboard sensor and custom announcements are built in, and Move up / Move down are always available; e2e and axe cover the keyboard path.
- [A new runtime dependency] → Three small packages, client-only, admin-page-only, pinned to a reviewed release; the API does not depend on them, so they can be replaced later.
- [Many starred repos push the full list down the home page] → Accepted for now; starring is an admin curation tool.
- [One portal-wide list may not suit every viewer] → Intentional (see Non-Goals); per-user favourites would be a separate capability.
- [`PATCH` has two optional fields, so partial-validity bodies are possible] → Validate every present field before writing, apply both in one update, and return 400 without writing if any is invalid.

- [The admin area is no longer one click from the bar, and needs JavaScript to reach from the header] → Accepted by request; the admin pages stay reachable by URL, and the menu opens in one click and is keyboard- and touch-usable. The header already needs JavaScript for Sign out and the theme toggle.
- [A long email crowds the header on narrow screens] → The button truncates the email with a maximum width; the search button and theme toggle keep their size, and e2e checks there is no horizontal scroll at phone width.

## Migration Plan

1. `pnpm db:generate` emits `ALTER TABLE "repos" ADD COLUMN "star_position" integer`; `pnpm db:migrate` applies it. Existing rows are null (unstarred), so the home page looks the same until an admin stars something.
2. Rollback: deploy the previous build (it ignores the column); dropping the column is optional.

## Open Questions

None that change specs or approach. Minor choices recorded as assumptions: the star and order are portal-wide, the Starred section sits above Repositories, new stars go to the end, reordering is drag and drop (with Move up / Move down as the no-drag alternative), and the star and order controls live on the admin page only, the account menu is a disclosure rather than an ARIA menu, and Sign out moves into it for every role.
