# Design

## Context

See `proposal.md` for motivation. Current state that shapes the approach:

- `loadHome()` (`src/server/home.ts`) calls `listRepos()` once and partitions the result into `starred` and `repos`; `RepoGrid` renders them as sections.
- `repos.is_allowed` and `repos.star_position` are the precedent for admin-curated state: columns on `repos`, written only by `updateRepoFlags` (`src/server/admin/repos.ts`) through `PATCH /api/admin/repos`, and untouched by the sync because `persist.ts` upserts with an explicit column list.
- Every read of `repos` goes through `src/server/queries/` and `visibleRepos`; `enforcement.test.ts` statically forbids reading the protected tables elsewhere, and `queries.test.ts` requires every exported query to be listed in `QUERY_FUNCTIONS`.
- Admin handlers in `src/server/admin/service.ts` own database access behind `requireAdmin`; routes stay thin. The admin page is `src/app/admin/workspace/page.tsx` with a `Tabs` component; repo rows live in `repo-access-manager.tsx` and `repo-access-row.tsx`.

## Goals / Non-Goals

**Goals:**
- Admin-managed folders with a name and description, each holding any number of repositories, shown as groups on the home page, with starred folders as tabs.
- Folder state that survives blocking, syncing and star changes, with no change to the visibility rule.

**Non-Goals:**
- Nested folders, a repository in several folders, manual ordering of unstarred folders, drag and drop for starred folders (Move up / Move down only), folder pages or URLs, folder-scoped search or filters, per-user folders, and showing the folder on repository or document pages. Any can follow without changing this data model, except multi-folder membership, which would replace the column with a join table.

## Decisions

**1. A `repo_folders` table and a nullable `repos.folder_id`.** The table holds `id`, `name`, `description` (nullable), `star_position` (nullable integer, null = not starred, the same scheme as `repos.star_position`) and timestamps, with a unique index on `lower(name)` so duplicates differing only in case fail at the database, not only in the handler. `repos.folder_id` references it with `ON DELETE SET NULL`, so deleting a folder ungroups its repositories in the same statement and cannot leave a dangling id. One column on `repos` makes "at most one folder" structural. Alternatives: a join table (allows many folders per repo, which the spec excludes, and adds a join to every home read); a free-text `folder` column on `repos` (no description, no empty folders, renames touch every repo).

**2. Folder reads live in the query layer.** A new `src/server/queries/folders.ts` exports `listFolders(db)` returning every folder (`id`, `name`, `description`, `starPosition`), listed in `NOT_QUERIES` rather than `QUERY_FUNCTIONS` because it returns no repository rows. It reads only `repo_folders`, which carries no repository data, so it needs no visibility filter itself; the gating is that `RepoSummary` gains `folderId` (read through `listRepos`, already filtered), and a folder is shown only if a visible repo points at it. `loadHome` joins the two in memory: folders with no visible, unstarred repository are dropped, the rest are sorted by `name` case-insensitively (then `id`). The admin Folders tab uses the same `listFolders` plus per-folder counts computed from the allow-all admin repo list, so blocked repos count there. Alternative: a SQL join with counts in `listRepos` (couples the repo list to folders and changes a query other callers use).

**3. Writes in `src/server/admin/folders.ts`, membership through the existing `PATCH`.** `createFolder`, `updateFolder` and `deleteFolder` validate explicitly, like `repos.ts` (name trimmed 1 to 80, description trimmed 0 to 500, empty description stored as null), return `{ ok: false, status }` results like `repos.ts`, and map a unique-violation to 409. Membership is not a new endpoint: `updateRepoFlags` accepts `folderId: number | null` beside `isAllowed` and `isStarred`, validates every present field before writing, and returns 404 when the id does not exist. That keeps one write path for repo flags and lets one request change several. Routes: `GET`/`POST /api/admin/folders` and `PATCH`/`DELETE /api/admin/folders/[id]`, each a thin route calling a `service.ts` handler that starts with `requireAdmin`. Alternatives: `PUT /api/admin/folders/[id]/repos` with the full member list (bulk, but needs the stale-set 409 logic of the star reorder for no benefit here); a separate membership endpoint (a second path that must stay consistent with the flags one).

**4. Home grouping happens in `loadHome`; starred wins.** `loadHome` still calls `listRepos` once, takes `starred` as today, then partitions the unstarred rest by `folderId` into `folders: { id, name, description, repos }[]` and `repos` (folderless). `RepoGrid` renders Starred, then one `RepoSection` per folder, then Repositories, reusing the existing `RepoSection` with an optional description paragraph under the heading. Heading ids derive from the folder id, not the name. A starred repository stays in Starred only, matching the "one section" rule of `starred-repos`, and keeps its `folder_id`. The empty state still depends on `starred + folders + repos` being empty. Alternative: show a starred repo in both places (breaks the one-section rule and double-counts).

**5. Description is text.** It is rendered as a plain text node (React escaping), never Markdown or HTML, so no sanitizer is involved and the architecture rule about untrusted rendering is not touched. Long descriptions wrap (`break-words`).

**6. Admin UI.** A `FolderManager` client component in a new **Folders** tab: a list of folders with description and member count, an inline create form, inline edit (name, description), and a two-step delete (the Delete button turns into "Confirm delete" and Cancel, naming the folder and its repository count). Each `RepoLine` in the Repository access list gets a `<select>` (labelled "Folder for acme/handbook", first option "No folder") fed by the folder list, which PATCHes `folderId` and updates the row only after the response (an error keeps the old value), like the Allow/Block button. The workspace page loads folders next to repos and passes them to both components; after a folder change the manager calls `router.refresh()` and updates its local state so the select options stay current. A native `<select>` keeps keyboard and screen-reader behaviour free; no new dependency.

**7. Sync independence.** `persist.ts` names its columns explicitly, so `folder_id` is never written by a sync; a persistence test pins this, as it does for `star_position`.

**8. Starred folders: same scheme as starred repos, smaller UI.** `repo_folders.star_position` carries flag and order together. `PATCH /api/admin/folders/[id]` accepts `isStarred` beside `name` and `description` (star appends at `max + 1`, unstar sets null). `PUT /api/admin/folders/starred` takes `{ folderIds: number[] }`, the complete starred list in the wanted order, and in one transaction (rows locked) rewrites positions to `0..n-1`; a different set is 409, malformed or unknown is 400. The Folders tab shows starred folders first with a star toggle and Move up / Move down buttons, omitted at the ends. No drag and drop: the buttons already satisfy WCAG 2.2 2.5.7, the list is short, and the existing sortable component is built around repository rows, so reusing it would mean generalizing it for little gain. `listFolders` returns `starPosition`; the order is position then id. Alternative: reuse `StarredRepoList` generalized over row type (dragging for folders too; larger change and a second consumer to keep in sync).

**9. Tabs are links, selected by `?folder=<id>`.** The home page is already server-rendered per request, so the tab bar is a `nav` of links (`/` and `/?folder=<id>`) with `aria-current="page"` on the current one, not the ARIA tabs widget and not client state. This gives shareable URLs and works without JavaScript; the page reads `searchParams.folder`. `loadHome(folderId?)` returns `tabs` (starred folders that have at least one visible repository, in order), the selected `folder` (with its visible repositories, starred ones included, ordered by owner then name) when the id matches a tab, and otherwise the All data (`starred`, `folders`, `repos`). An unusable id silently falls back to All (no redirect, no error). The `Tabs` component of the admin page is not reused: it keeps every panel mounted and is client-state only. Alternatives: client-side tabs with all folders' cards rendered in the page (hides content behind JS and sends every card twice); a route per folder (`/folders/<id>`; new page, new not-found handling, and no real benefit over a query parameter).

**10. Tab visibility follows repo visibility.** A tab exists only if a visible repository is in the folder, computed in `loadHome` from `listRepos` (already visibility-filtered) exactly like folder sections, so blocking cannot leak a folder's name or description. A folder tab shows starred repositories of the folder too, because it is a filtered view; the one-section rule applies within the All view only.

**11. Optional by construction.** No seed row, no default folder, no setting, no onboarding step. All new state is nullable or absent: no folder rows means `listFolders` returns `[]`, `loadHome` yields no `tabs` and no `folders`, and `RepoGrid` renders the same two sections as before. The row `<select>` is rendered only when at least one folder exists, so the Repository access list is unchanged until a folder is created. `setupNeeded`, the workspace status line and the admin overview do not reference folders. The Folders tab is the only always-visible trace; it shows an empty state that says folders are optional.

## Risks / Trade-offs

- [Two admins edit at once] → Writes are single statements; the unique index decides duplicate names (409), and `ON DELETE SET NULL` makes a delete racing an assignment safe (the assignment gets a foreign-key failure, mapped to 404).
- [A folder of only starred repositories vanishes from the home page] → Intentional under the one-section rule; the repositories are still on the page, under Starred. Unstarring returns them.
- [Many starred folders overflow the tab bar on a phone] → The bar scrolls horizontally inside its own container (the page itself does not), and e2e checks the phone width.
- [Many folders lengthen the home page] → Accepted; folders are an admin curation tool and sections are flat lists like today.
- [Folder name or description reveals something about hidden repositories] → A folder is only returned to the home page when a visible repository is in it; the admin tab is admin-only.
- [Single-folder membership may later prove too limiting] → Documented as a non-goal; moving to a join table is a data migration, not a rewrite of the admin or home markup.

## Migration Plan

1. `pnpm db:generate` emits `CREATE TABLE "repo_folders"`, the unique index on `lower(name)`, and `ALTER TABLE "repos" ADD COLUMN "folder_id" integer REFERENCES ... ON DELETE SET NULL`. Existing rows get null, so the home page is unchanged until an admin creates a folder.
2. Rollback: deploy the previous build (it ignores the column and table); dropping them is optional.

## Open Questions

None that change specs or approach. Assumptions recorded: folders are flat, a repository is in one folder, unstarred folders are ordered by name, starred folders by the admin-set order, folder tabs use a query parameter on the home page, and there are no dedicated folder pages.
