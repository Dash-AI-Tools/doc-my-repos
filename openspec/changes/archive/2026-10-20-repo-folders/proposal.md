# Proposal

## Why

The home page is one flat list of every visible repository. In an org with dozens of repos, readers cannot tell which belong together (a product's services, a team's repos). Admins already curate the portal (allow/block, star); they should also be able to group repositories into named, described folders.

## What Changes

- Admins can **create, rename, describe and delete folders** on the admin Workspace configuration page, in a new **Folders** tab. A folder has a name and an optional plain-text description.
- A repository belongs to **at most one folder**. An admin assigns it from a folder control on its row in the Repository access list, or clears it; a folder can hold any number of repositories.
- The home page shows, below the Starred section, **one section per folder** (heading, description, repository count and the same cards), in folder-name order, followed by the **Repositories** section holding every repository that is in no folder. With no folders, the home page is unchanged.
- A folder is only shown when it has at least one visible repository, so blocking all of a folder's repositories hides it. Blocking a repository keeps its folder, so re-allowing returns it to the same folder.
- Deleting a folder does not delete or hide anything: its repositories move to the Repositories section.
- Admins can **star** a folder and order the starred folders (Move up / Move down), the same portal-wide idea as starred repositories. Starred folders become **tabs** at the top of the home page: an **All** tab (the layout above, the default) and one tab per starred folder, in the admin-set order. A folder tab shows that folder's description and all its visible repositories. The selected tab is in the URL (`/?folder=<id>`), so it can be linked and works without JavaScript. Folders that are not starred only appear as sections in All.
- **Folders are optional.** Nothing depends on them: with no folders the portal behaves exactly as it does today, setup and onboarding do not mention them, and no repository needs a folder to be synced, searched, read or shown. Admins who never open the Folders tab are unaffected.
- A sync never changes folder membership. Non-admins cannot change folders or membership (403).
- Not changed: search, repository and document pages, command palette, the repo card, and the visibility rule.

## Capabilities

### New Capabilities

- `repo-folders`: admin-managed folders (name, description), repository membership, and how folders group the home page.

### Modified Capabilities

- `starred-repos`: the "Starred repositories lead the home page" requirement now sits above folder sections as well as the Repositories section, within the All tab; a starred repository stays in the Starred section only.

## Impact

- Data: new `repo_folders` table (with a nullable `star_position`) and a nullable `repos.folder_id` foreign key (on delete set null); one Drizzle migration.
- Server: new `src/server/admin/folders.ts` (create, update, delete, list) and handlers in `src/server/admin/service.ts`; `updateRepoFlags` in `src/server/admin/repos.ts` gains `folderId`; new read in `src/server/queries/` (registered in `QUERY_FUNCTIONS`); `RepoSummary.folderId`; `src/server/home.ts` groups by folder.
- API: `GET`/`POST /api/admin/folders`, `PATCH`/`DELETE /api/admin/folders/[id]` (name, description, `isStarred`), `PUT /api/admin/folders/starred` (order), and `folderId` accepted by `PATCH /api/admin/repos`. All admin-guarded.
- UI: new `folder-manager` component and Folders tab in `src/app/admin/workspace/page.tsx`; folder select on rows in `repo-access-manager.tsx`/`repo-access-row.tsx`; folder sections in `repo-grid.tsx` and `src/app/page.tsx`, plus a home tab bar component (links, not client state).
- Tests: unit, integration (test database), component, and `e2e/home.spec.ts`. Docs: `DESIGN.md` only if the folder heading introduces a new pattern.
- Dependencies: none.
