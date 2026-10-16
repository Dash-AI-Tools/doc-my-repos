# starred-repos Specification

## Purpose

Lets admins pick repositories that lead the home page and arrange their order, as one portal-wide list shared by every viewer.

## Requirements

### Requirement: Admin starring
The system SHALL let an admin star and unstar any synced repository, including a blocked one. A star is a single portal-wide flag on the repository: it is not tied to the admin who set it, and setting a star to the value it already has SHALL succeed and change nothing (a repeated star SHALL NOT move the repository). New repositories SHALL start unstarred. A newly starred repository SHALL be placed at the end of the starred order.

#### Scenario: Admin stars a repository
- **WHEN** an admin stars a repository
- **THEN** the request succeeds, the repository is starred for every viewer, and it is last in the starred order

#### Scenario: Admin unstars a repository
- **WHEN** an admin unstars a starred repository
- **THEN** it is no longer starred for any viewer, and the remaining starred repositories keep their relative order

#### Scenario: Repeating a star is harmless
- **WHEN** an admin stars an already starred repository
- **THEN** the request succeeds and the repository stays starred in the same place in the order

#### Scenario: Unknown repository
- **WHEN** an admin stars a repository that is not synced
- **THEN** the request fails with 404 and nothing changes

#### Scenario: Invalid request
- **WHEN** the star request lacks an owner or name, or the star value is not a boolean
- **THEN** the request fails with 400 and nothing changes

### Requirement: Admin ordering of starred repositories
The system SHALL let an admin set the order of the starred repositories by submitting the complete list of starred repositories in the wanted order. The order SHALL be a single portal-wide order, and it SHALL be stored so that it is the same for every viewer and survives restarts, syncs, blocking and re-allowing. A submitted list SHALL be rejected with 409 and no change unless it names exactly the repositories that are starred at that moment, each once (so a stale list from another admin's earlier change cannot silently overwrite it). Unknown or malformed entries SHALL be rejected with 400 and no change.

#### Scenario: Admin reorders
- **WHEN** an admin submits the starred repositories in a new order
- **THEN** the request succeeds and the starred order for every viewer is the submitted order

#### Scenario: Stale list rejected
- **WHEN** an admin submits a list that is missing a repository starred in the meantime, or names one that was unstarred
- **THEN** the request fails with 409 and the order is unchanged

#### Scenario: Malformed list rejected
- **WHEN** the submitted list repeats a repository, names a repository that is not synced, or is not a list of owner/name pairs
- **THEN** the request fails with 400 and the order is unchanged

#### Scenario: Blocked repository keeps its place
- **WHEN** a blocked starred repository is part of the starred order
- **THEN** it can be reordered like any other, and it keeps its place when re-allowed

### Requirement: Starring and ordering are admin only
The system SHALL reject star, unstar and reorder attempts from non-admin users with 403 and unauthenticated callers with 401, and SHALL NOT change any star or the order in either case. Viewers SHALL see the result but no control to change it.

#### Scenario: Viewer cannot star or reorder
- **WHEN** a user with the `user` role tries to star a repository or reorder the starred list
- **THEN** the response is 403 and nothing changes

#### Scenario: Unauthenticated caller cannot star or reorder
- **WHEN** a request without a session tries to star a repository or reorder the starred list
- **THEN** the response is 401 and nothing changes

### Requirement: Starred repositories lead the home page
The system SHALL show starred, visible repositories in a **Starred** section above the **Repositories** section on the home page, in the admin-set order. A repository SHALL appear in exactly one of the two sections. The Repositories section SHALL keep the existing order (owner, then name, case-insensitive). When no visible repository is starred, the home page SHALL be unchanged and SHALL NOT show an empty Starred section.

#### Scenario: Starred repository moves to the top
- **WHEN** a visitor opens the home page and a repository is starred
- **THEN** it appears in the Starred section above the Repositories section, and not in the Repositories section

#### Scenario: Admin order is shown
- **WHEN** several repositories are starred and an admin has ordered them
- **THEN** the Starred section lists them in that order, whatever their names, and the Repositories section lists the rest by owner then name

#### Scenario: Nothing starred
- **WHEN** no visible repository is starred
- **THEN** the home page shows only the Repositories section, as before

#### Scenario: Every viewer sees the same stars and order
- **WHEN** an admin stars or reorders repositories
- **THEN** every viewer, admin or not, sees the new Starred section on their next page load

#### Scenario: Starred repository keeps its card
- **WHEN** a starred repository is listed
- **THEN** its card shows the same information and link as any other repository card, including private and error states

### Requirement: Stars respect blocking and syncing
The system SHALL keep the visibility rule above stars: a blocked repository SHALL NOT appear on the home page, starred or not. A star and its place in the order SHALL survive blocking, re-allowing and every sync, and SHALL be changed only by an admin starring, unstarring or reordering.

#### Scenario: Blocked starred repository is hidden
- **WHEN** an admin blocks a starred repository
- **THEN** it disappears from the home page, including the Starred section, and the other starred repositories keep their order

#### Scenario: Re-allowed repository returns in place
- **WHEN** an admin re-allows a repository that was starred when it was blocked
- **THEN** it reappears in the Starred section at its previous place without being starred again

#### Scenario: Sync keeps stars and order
- **WHEN** a sync updates or re-discovers a starred repository
- **THEN** the repository is still starred, in the same place in the order

### Requirement: Star and order controls on the admin repository list
The system SHALL show on the admin Repository access page the starred repositories first, in the admin-set order, followed by the other repositories. Each repository SHALL have a control to star or unstar it next to the Allow/Block control. Each starred repository SHALL have a drag handle that lets an admin drag it to a new place in the starred list, and SHALL have Move up and Move down buttons as an alternative that needs no dragging. After a change the page SHALL show the new state, and a failed change SHALL show an error and keep the previous state.

#### Scenario: Admin toggles from the list
- **WHEN** an admin activates the star control of an unstarred repository on the admin page
- **THEN** the repository shows as starred at the end of the starred group, and the home page lists it last under Starred

#### Scenario: Admin drags a repository
- **WHEN** an admin drags a starred repository by its handle and drops it at another place in the starred list
- **THEN** the list shows the new order immediately and the home page shows the same order

#### Scenario: Dropping in place changes nothing
- **WHEN** an admin drops a dragged repository where it started, or cancels the drag
- **THEN** no request is sent and the order is unchanged

#### Scenario: Admin moves a repository without dragging
- **WHEN** an admin activates Move up on a starred repository
- **THEN** it swaps places with the one above it, and the home page shows the same order

#### Scenario: Ends of the list
- **WHEN** a starred repository is first or last in the starred list
- **THEN** it does not offer Move up (first) or Move down (last)

#### Scenario: Failed change keeps state
- **WHEN** a star, drag or move request fails (including a stale list)
- **THEN** an error message is shown and the list returns to its previous state

#### Scenario: Reordering works by keyboard
- **WHEN** a keyboard user focuses a drag handle, picks the row up, moves it with the arrow keys and drops it
- **THEN** the order changes as it would with a pointer, and the pick-up, each move and the drop are announced to assistive technology with the repository's name and its position

#### Scenario: Reordering works by touch
- **WHEN** a touch user drags a row by its handle on a phone-width screen
- **THEN** the row moves and the page does not scroll instead of dragging

#### Scenario: Controls name their repository and suit both themes
- **WHEN** any star, handle or move control is read by assistive technology or viewed in light or dark theme
- **THEN** it names the repository it acts on, shows its state, has a visible focus indicator and is readable in both themes
