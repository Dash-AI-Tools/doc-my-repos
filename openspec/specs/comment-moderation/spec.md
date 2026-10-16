# comment-moderation Specification

## Purpose

Gives admins the means to oversee comments across the portal, remove inappropriate ones, clean up comments whose document is gone, and turn the feature off.

## Requirements

### Requirement: Admin Comments page
The system SHALL give admins a Comments page in the admin area listing comments across all repositories, newest first, with the author (name and email), whether it was posted as the organization, the repository and document, the time, a text excerpt, and its state (live, deleted, or orphaned because its document or repository no longer exists), with filters for state and repository and paging. The page SHALL include comments in blocked repositories, marked as such. Non-admins SHALL be refused with 403 and unauthenticated callers with 401.

#### Scenario: Listing
- **WHEN** an admin opens the Comments page
- **THEN** they see recent comments from all repositories with the details above

#### Scenario: Orphaned filter
- **WHEN** an admin filters by orphaned
- **THEN** only comments whose document or repository no longer exists are listed

#### Scenario: Blocked repository included
- **WHEN** a repository is blocked
- **THEN** its comments are still listed for admins, marked as in a blocked repository

#### Scenario: Not for viewers
- **WHEN** a user with the `user` role opens the page or its API
- **THEN** they receive 403 and no comment data

### Requirement: Admin deletion
The system SHALL let an admin delete any comment from the Comments page or from the document, with the same effect as an author deleting it (text removed from storage, placeholder when it has replies), and SHALL record in the log which admin deleted which comment, without the comment's text. A deleted comment SHALL show to users only as a placeholder, never as the admin's reason or identity.

#### Scenario: Admin removes a comment
- **WHEN** an admin deletes another user's comment that has replies
- **THEN** the thread shows "This comment was deleted" and the text is no longer stored

#### Scenario: Logged without text
- **WHEN** an admin deletes a comment
- **THEN** the log has the admin, the comment id and the time, and not the text

### Requirement: Permanent removal
The system SHALL let an admin permanently remove comments that are deleted or orphaned (and a whole orphaned document's comments in one action), after a confirmation that states how many will be removed. Permanent removal SHALL be refused for live comments on visible documents and SHALL not be undoable.

#### Scenario: Remove an orphaned document's comments
- **WHEN** an admin confirms removal of the comments of a document that no longer exists
- **THEN** all of them are deleted and the page shows the count removed

#### Scenario: Live comment protected
- **WHEN** an admin attempts permanent removal of a live comment on an existing document
- **THEN** it is refused and the comment is unchanged

### Requirement: Turn comments off
The system SHALL show and accept comments only when `comments.enabled` is true in the configuration (default true). When it is false, the Comments section and count SHALL not be shown, `/api/comments*` SHALL answer 404, the admin Comments page SHALL explain comments are off and still allow permanent removal of stored comments, and stored comments SHALL be kept.

#### Scenario: Disabled
- **WHEN** `comments.enabled` is false
- **THEN** document pages show no comments section and the comment APIs answer 404

#### Scenario: Re-enabled
- **WHEN** the setting is turned back on
- **THEN** previously stored comments are shown again

#### Scenario: Default
- **WHEN** the configuration does not mention comments
- **THEN** comments are enabled
