# repo-folders Specification

## Purpose
Lets admins organize repositories into named, described folders, and shows those folders as groups on the home page, so readers can find related repositories together.

## Requirements

### Requirement: Folders are optional
The system SHALL work completely without folders. It SHALL NOT create a default folder, require a folder for any repository, mention folders in setup or onboarding, or change any page, search result, API response or sync behavior other than the home page and admin pages described here when no folder exists. A repository SHALL be fully usable while in no folder.

#### Scenario: Fresh install
- **WHEN** a workspace has never created a folder
- **THEN** sync, home, search, repository and document pages behave exactly as before folders existed, and no setup step or banner mentions folders

#### Scenario: Last folder deleted
- **WHEN** an admin deletes the only folder
- **THEN** the home page looks as it did before the folder was created, with no tab bar and no folder sections

#### Scenario: Admin ignores the feature
- **WHEN** an admin never opens the Folders tab
- **THEN** the Repository access list shows no folder control and works as before

### Requirement: Admin folder management
The system SHALL let admins create, edit and delete folders. A folder has a name (1 to 80 characters after trimming, unique ignoring case) and an optional description (plain text, at most 500 characters). Invalid input SHALL be rejected with 400, a duplicate name with 409, and an unknown folder with 404, each without changing anything.

#### Scenario: Create a folder
- **WHEN** an admin creates a folder named "Payments" with a description
- **THEN** the folder exists, appears in the Folders tab with zero repositories, and is returned with its id

#### Scenario: Duplicate name
- **WHEN** an admin creates or renames a folder to a name another folder has, ignoring case
- **THEN** the request is rejected with 409 and the existing folders are unchanged

#### Scenario: Invalid input
- **WHEN** the name is empty or longer than 80 characters, or the description is longer than 500
- **THEN** the request is rejected with 400 and nothing is written

#### Scenario: Edit a folder
- **WHEN** an admin changes a folder's name or description
- **THEN** the home page shows the new text on the next page load and the folder keeps its repositories

#### Scenario: Description is text
- **WHEN** a description contains HTML or Markdown syntax
- **THEN** it is shown as literal text everywhere, never interpreted

### Requirement: Repository membership
The system SHALL let admins put a repository in one folder, move it to another, or remove it from its folder, from the Repository access list. A repository SHALL belong to at most one folder; a folder MAY hold any number of repositories. Assigning to an unknown folder or repository SHALL be rejected with 404 and change nothing.

#### Scenario: Assign a repository
- **WHEN** an admin selects the folder "Payments" for a repository
- **THEN** the repository is in that folder, the Folders tab counts it, and the home page shows it in that folder's section

#### Scenario: Move between folders
- **WHEN** an admin selects another folder for a repository that is already in one
- **THEN** it leaves the first folder and is only in the second

#### Scenario: Remove from a folder
- **WHEN** an admin clears the folder of a repository
- **THEN** the repository appears in the Repositories section

#### Scenario: Failed change keeps state
- **WHEN** an assignment request fails
- **THEN** an error message is shown and the row keeps its previous folder

### Requirement: Admin starring and ordering of folders
The system SHALL let admins star and unstar a folder and order the starred folders. A newly starred folder SHALL go to the end of the starred folders. Starring is portal-wide: every viewer sees the same starred folders in the same order. Reordering SHALL require the complete list of starred folders and be rejected with 409, changing nothing, when that list is not exactly the currently starred set.

#### Scenario: Star a folder
- **WHEN** an admin stars a folder
- **THEN** it becomes the last starred folder and every viewer sees its tab on the next page load

#### Scenario: Reorder starred folders
- **WHEN** an admin moves a starred folder up or down in the Folders tab
- **THEN** the starred folders take the new order and the home page tabs follow it

#### Scenario: Stale reorder
- **WHEN** a reorder request lists a different set of starred folders than is currently starred
- **THEN** it is rejected with 409 and the order is unchanged

#### Scenario: Ends of the list
- **WHEN** a starred folder is first or last among starred folders
- **THEN** it does not offer Move up (first) or Move down (last)

#### Scenario: Unstar
- **WHEN** an admin unstars a folder
- **THEN** its tab disappears, its repositories and membership are unchanged, and it still appears as a section in All

### Requirement: Folder tabs on the home page
The system SHALL show, at the top of the home page when at least one starred folder has a visible repository, a tab bar with an **All** tab followed by one tab per such folder in the admin-set order. All SHALL show the home page as described by the other requirements.

#### Scenario: Tabs shown
- **WHEN** two starred folders have visible repositories
- **THEN** the home page shows the tabs All and those two folders, in the admin-set order, with All selected

#### Scenario: No starred folders
- **WHEN** no starred folder has a visible repository
- **THEN** no tab bar is shown

### Requirement: Folder tab content and selection
The system SHALL show in a folder tab the folder name, its description when set, and every visible repository in the folder (starred ones included), ordered by owner then name. The selected tab SHALL be given by the `folder` query parameter; a missing or unusable value (unknown, unstarred, or no visible repository) SHALL show All.

#### Scenario: Open a folder tab
- **WHEN** a visitor opens the tab of a starred folder
- **THEN** the page shows only that folder's name, description and visible repositories, the URL carries the folder, and the tab is marked as current

#### Scenario: Starred repository in a folder tab
- **WHEN** a starred repository is in a starred folder
- **THEN** it appears in that folder's tab, and in All only under Starred

#### Scenario: Unusable tab link
- **WHEN** the `folder` parameter names a folder that does not exist, is not starred, or has no visible repository
- **THEN** the All view is shown

#### Scenario: Blocked repositories
- **WHEN** every repository of a starred folder is blocked
- **THEN** its tab is not shown, and it returns when a repository is allowed again

#### Scenario: Works without JavaScript
- **WHEN** scripting is unavailable
- **THEN** the tabs still switch views through ordinary links

### Requirement: Delete a folder
The system SHALL delete a folder only after the admin confirms. Deleting SHALL NOT delete, block or hide any repository: its repositories become folderless. A deleted folder's tab and star disappear with it, and the remaining starred folders keep their order.

#### Scenario: Delete a folder with repositories
- **WHEN** an admin confirms deleting a folder that holds three repositories
- **THEN** the folder is gone and all three appear in the Repositories section of the home page

#### Scenario: Not confirmed
- **WHEN** an admin starts a delete and cancels
- **THEN** the folder and its repositories are unchanged

### Requirement: Folders on the home page
The system SHALL show, in the All view of the home page, below the Starred section and above the Repositories section, one section per folder that has at least one visible, unstarred repository. Each section SHALL show the folder name, its description when set, the count of repositories in it, and the same repository cards as elsewhere, ordered by owner then name. Sections SHALL be ordered by folder name, case-insensitive.

#### Scenario: Grouped repositories
- **WHEN** a visitor opens the home page and two repositories are in the folder "Payments"
- **THEN** a "Payments" section shows its description and both cards, and neither appears in the Repositories section

#### Scenario: Folder order
- **WHEN** folders "Platform" and "Billing" both have visible repositories
- **THEN** "Billing" is listed before "Platform"

#### Scenario: Folder with only blocked repositories
- **WHEN** every repository in a folder is blocked
- **THEN** the folder does not appear on the home page, and still appears in the admin Folders tab

#### Scenario: Blocking keeps membership
- **WHEN** a repository in a folder is blocked and later allowed again
- **THEN** it reappears in the same folder without being reassigned

#### Scenario: Empty folder
- **WHEN** a folder has no repositories
- **THEN** it does not appear on the home page

### Requirement: Folderless repositories on the home page
The system SHALL list in the Repositories section of the All view the visible, unstarred repositories that are in no folder, and SHALL omit that section when there are none. When no folder has a visible repository, the home page SHALL look as it did before folders existed.

#### Scenario: Folderless repositories
- **WHEN** some visible repositories are in no folder
- **THEN** they are listed in the Repositories section after the folder sections

#### Scenario: Everything is in a folder
- **WHEN** every visible unstarred repository is in a folder
- **THEN** no Repositories section is shown

#### Scenario: No folders
- **WHEN** no folder exists
- **THEN** the home page shows the Starred and Repositories sections exactly as before

### Requirement: Folders are admin only and survive sync
The system SHALL allow folder creation, editing, deletion, starring, ordering and membership changes only to signed-in admins: no session is 401 and a viewer is 403, with nothing changed. A repository sync SHALL NOT change folders or any repository's folder.

#### Scenario: Viewer cannot change folders
- **WHEN** a non-admin sends a folder or membership change
- **THEN** the response is 403 and nothing changes

#### Scenario: Signed-out request
- **WHEN** a request without a session reaches a folder endpoint
- **THEN** the response is 401 and nothing changes

#### Scenario: Sync keeps membership
- **WHEN** a sync updates or re-discovers a repository that is in a folder
- **THEN** the repository is still in that folder

### Requirement: Folder controls on the admin page
The system SHALL provide a Folders tab on the Workspace configuration page that lists every folder (including empty ones) with its description and repository count, with controls to create, edit, delete and star or unstar, Move up and Move down buttons for starred folders, and SHALL show a folder control on each row of the Repository access list. After a change the page SHALL show the new state, and a failed change SHALL show an error and keep the previous state.

#### Scenario: Folders listed with counts
- **WHEN** an admin opens the Folders tab
- **THEN** each folder is listed with its description and how many repositories it holds, blocked ones included

#### Scenario: No folders yet
- **WHEN** no folder exists
- **THEN** the Folders tab shows a short note that folders are optional and a create form, and the Repository access rows show no folder control

#### Scenario: Control is labelled
- **WHEN** a keyboard or screen-reader user reaches a repository row's folder control
- **THEN** it is named after the repository and shows the current folder or "No folder"
