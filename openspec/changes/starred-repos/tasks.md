# Tasks

## 1. Data and server

- [ ] 1.1 Add nullable `repos.star_position` (integer, null = not starred) to `src/server/db/schema.ts`, run `pnpm db:generate`, and verify the migration applies cleanly from empty and leaves existing rows unstarred (extend `schema.test.ts`/`migrate.test.ts`)
- [ ] 1.2 Add `starPosition` and derived `isStarred` to `RepoSummary`, the summary columns and `toSummary` in `src/server/queries/repos.ts`, and verify the query tests return them and blocked starred repos are still hidden by the visibility filter
- [ ] 1.3 Add `setRepoStarred` beside `setRepoAllowed` in `src/server/admin/repos.ts` with a shared case-insensitive owner/name lookup (star appends at `max + 1`, repeat star keeps the place, unstar sets null), and verify unit tests cover star, unstar in the middle then star again, repeat, case-insensitive match, 400 for bad input and 404 for an unknown repo
- [ ] 1.4 Extend `PATCH /api/admin/repos` (`handleSetRepoAllowed` in `src/server/admin/service.ts`, renamed if it no longer fits) to accept `isStarred` and/or `isAllowed`, validating all present fields before writing, and verify 401 without a session, 403 for a `user`, 400 for a body with neither field or a non-boolean, and that `isAllowed`-only requests behave as before
- [ ] 1.5 Add `reorderStarredRepos` in `src/server/admin/repos.ts` (single transaction, exact-set check, positions rewritten to `0..n-1`) and verify unit tests for a valid reorder, blocked repos included, 409 for a missing/extra/stale entry, 400 for duplicates, unknown repos and a malformed body, and nothing written on failure
- [ ] 1.6 Add `PUT /api/admin/repos/starred` (thin route plus a handler in `service.ts`, admin-guarded) and verify 401, 403, 409, 400 and a 200 response with the new ordered list
- [ ] 1.7 Verify a sync that updates or re-discovers a starred repo keeps its star and place, and that blocking then re-allowing keeps both (integration tests against the test database)

## 2. Home page

- [ ] 2.1 Make `loadHome` return `starred` (ordered by `starPosition`, then `id`) and `repos` (the rest, alphabetical), and verify unit tests for no stars, some stars with an order that differs from alphabetical, all stars and the error state
- [ ] 2.2 Render the Starred section in `RepoGrid` and `src/app/page.tsx` (heading with count, same cards, Repositories section omitted when everything is starred, no empty Starred section), and verify component tests for each case and that the empty state still shows only when there are no repositories
- [ ] 2.3 Check the home page in light and dark themes and at phone width, and update `DESIGN.md` only if the Starred heading introduces a new pattern

## 3. Admin UI

- [ ] 3.1 Add `starPosition`/`isStarred` to `RepoAccessRow` and a star toggle button with `aria-pressed` and a visible label next to Allow/Block in `src/components/repo-access-manager.tsx`, with error handling that keeps the previous state, and verify component tests for toggle success, toggle failure and keyboard activation
- [ ] 3.2 Add `@dnd-kit/core`, `@dnd-kit/sortable` and `@dnd-kit/utilities` with `pnpm add` (release at least two weeks old, version pinned), and verify `pnpm install --frozen-lockfile`, typecheck and the production build succeed and that only the admin page imports them
- [ ] 3.3 Split the admin list into a Starred group (in order) and the rest, and make the Starred group a sortable list with a drag handle per row (pointer, touch and keyboard sensors, vertical axis only, drop on the start place or cancel sends nothing), optimistic reorder with rollback on failure including 409, and verify component tests for a drop, a keyboard move, a cancel, failure rollback and that clicking the star or Allow/Block does not start a drag
- [ ] 3.4 Add Move up / Move down buttons named after the repository (omitted at the ends of the list) sharing the reorder function, and custom drag announcements naming the repository and its position ("Picked up acme/handbook, position 2 of 5"), and verify component tests for both buttons, the edge cases and the announcements
- [ ] 3.5 Verify `/admin/repos` passes the star fields through from `getAdminRepos`, that blocked starred repos stay in the starred group, and that the handle and buttons are readable and focus-visible in light and dark themes, and dragging works at phone width

## 4. Account menu

- [ ] 4.1 Build the client `AccountMenu` (email trigger with `aria-expanded`/`aria-controls`, truncation, chevron; panel with the admin links for admins, a rule, and Sign out for everyone; `aria-current` on the current admin page; closes on Escape with focus returned, outside pointerdown, link activation and route change), and verify component tests for admin and viewer menus, each way of closing, keyboard Tab order and the sign-out request and redirect
- [ ] 4.2 Use it in `src/components/site-header.tsx`: remove the Admin link from the main nav, the `xl`-only email span and the inline `LogoutButton` (delete `logout-button.tsx` once unused), and render nothing when signed out; verify the header tests show no administration link or Sign out in the bar, for admin and viewer, and nothing for a signed-out visitor
- [ ] 4.3 Check the menu and trigger in light and dark themes, at phone width (menu inside the viewport, no horizontal scroll) and at the widths where the header wraps, then update the Site Header section of `DESIGN.md`; verify with an axe pass on a page with the menu open

## 5. End to end and wrap-up

- [ ] 5.1 Add e2e coverage in `e2e/home.spec.ts` (and the admin flow if the stack supports it): starring puts a repo under Starred, dragging it (by pointer, and by keyboard) changes the home order, Move up changes it without dragging, unstarring returns it to the list, a blocked starred repo is hidden and returns in place, an admin reaches Users, Repository access and GitHub configuration through the email menu while the top bar shows no Admin link, and an axe pass on the home page with a Starred section and on `/admin/repos` is clean
- [ ] 5.2 Run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:e2e`, and `openspec validate starred-repos`, and verify all pass
