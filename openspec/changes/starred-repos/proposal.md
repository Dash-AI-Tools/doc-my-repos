# Proposal

## Why

The home page lists every visible repository alphabetically by owner and name. In an org with many repos, the ones everyone actually needs (the platform handbook, the main product docs) sit wherever the alphabet puts them. Admins already curate the portal (allow/block); they should also be able to pick the repos that lead the homepage and decide in which order they appear.

## What Changes

- Admins can **star** and **unstar** a repository. The star is a single, portal-wide flag: every viewer sees the same starred set in the same order, not a per-admin favourite list.
- Admins can **arrange the order** of the starred repositories on the admin Repository access page. A newly starred repository goes to the end of the starred list; admins then **drag it to its place** by a handle on the row. Dragging also works by keyboard and touch, and Move up / Move down buttons give a no-drag way to do the same.
- The home page shows starred repositories in their own **Starred** section above the existing **Repositories** list, in the order the admins set. The Repositories section keeps its owner/name alphabetical order. A repository appears in exactly one section.
- With no starred repositories, the home page is unchanged (no empty Starred section).
- Star, unstar and reorder live on the existing admin Repository access page (`/admin/repos`), next to Allow/Block, backed by the admin repos API.
- Non-admins cannot change stars or their order (403, nothing changes). Viewers only see the result.
- Blocking a repository still hides it everywhere, starred or not. Its star and its place in the order are kept, so re-allowing it returns it to the same spot in the Starred section.
- A sync never changes a star or the order.
- **Account menu in the header.** The admin pages are no longer linked from the top bar. The signed-in user's email in the header becomes a button that opens an account menu: for admins it lists Administration, Users, Repository access and GitHub configuration; for every user it ends with Sign out, which moves out of the bar into the menu. The email shows at every screen width (today it is hidden below 1280px). The main navigation loses its **Admin** link. Hiding the links is not access control; the admin pages and APIs stay guarded as before.
- Not changed: search, repository and document pages, the repo card's markup, and per-user favourites.

## Capabilities

### New Capabilities

- `starred-repos`: admin-curated, portal-wide starring and ordering of repositories, and how starred repositories lead the home page.

- `account-menu`: the header's email-triggered account menu, which holds the administration links and Sign out.

### Modified Capabilities

- None. The home grid and allow/block behaviour live in the `docmyrepos-mvp` (`repo-space`) and `login-access-control` (`access-control`) change specs, which are not yet archived into `openspec/specs/`. This change adds a new capability that refines them and does not rewrite their requirements.

## Impact

- Data: new nullable `repos.star_position integer` column (null means not starred) and a Drizzle migration.
- Server: `src/server/admin/repos.ts` and `service.ts` (set-starred and reorder actions and handlers), `src/app/api/admin/repos/route.ts` (accept `isStarred` on `PATCH`) and a new route for reordering, `src/server/queries/repos.ts` (`RepoSummary.starPosition`), `src/server/home.ts` (split and order starred). Reads go through the existing visibility filter; no new read path.
- Header: `src/components/site-header.tsx` (drop the Admin nav link and the inline email and Sign out), a new client `account-menu` component, and `src/components/logout-button.tsx` (its sign-out logic moves into the menu).
- UI: `src/components/repo-access-manager.tsx` (star toggle, Starred group as a sortable list with drag handles and Move up / Move down buttons), `src/components/repo-grid.tsx` and `src/app/page.tsx` (Starred section).
- Tests: unit and integration tests for the toggle, reorder, authorization and ordering, component tests, and an update to `e2e/home.spec.ts`.
- Docs: `DESIGN.md` (Site Header section gains the account menu; also the Starred section and drag handle if they introduce new patterns).
- Dependencies: adds `@dnd-kit/core`, `@dnd-kit/sortable` and `@dnd-kit/utilities` (client-side only, loaded on the admin page). Env and config are unchanged.
