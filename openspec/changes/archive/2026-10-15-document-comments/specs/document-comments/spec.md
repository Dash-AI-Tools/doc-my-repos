## Purpose

Lets people discuss a document on its own page: signed-in users, and the organization through its admins, can start threads, reply, edit, delete and resolve comments that are stored in the portal and visible only where the document is.

## ADDED Requirements

### Requirement: Comments section on a document
The system SHALL show on every document page a "Comments" section after the document body, with the number of comments, the threads in order of creation (oldest first), and a form to start a new thread. The document header SHALL show the comment count as a link to the section. The section SHALL be readable without script, and posting SHALL require script.

#### Scenario: Section shown
- **WHEN** a signed-in user opens a document that has three comments
- **THEN** the page shows a Comments section with the count 3, the threads, and a form to add a comment

#### Scenario: Count link
- **WHEN** a user follows the comment count link in the document header
- **THEN** the page scrolls to the Comments section

#### Scenario: No comments yet
- **WHEN** a document has no comments
- **THEN** the section says so and offers the form

#### Scenario: Without script
- **WHEN** the page is loaded with scripts disabled
- **THEN** the existing comments are readable and the form area explains that script is needed to post

### Requirement: Who may read and write
The system SHALL let any signed-in user who can see a document read its comments, and any signed-in user who can see it post comments on it. Disabled users SHALL be unable to read or post. Reading or posting for a document the user cannot see (unknown, or in a blocked repository) SHALL be refused as not found. Unauthenticated requests SHALL be refused with 401.

#### Scenario: Viewer can comment
- **WHEN** a user with the `user` role posts a comment on a visible document
- **THEN** it is stored and shown

#### Scenario: Hidden document
- **WHEN** a user posts a comment on a document in a blocked repository
- **THEN** the request is refused as not found and nothing is stored

#### Scenario: Signed out
- **WHEN** a request without a session reads or posts comments
- **THEN** it is refused with 401

### Requirement: Post and reply
The system SHALL let a user start a thread with a comment of 1 to 4,000 characters and reply to a thread with comments of the same size. Replies SHALL be one level deep: a reply to a reply SHALL attach to the same thread. The new comment SHALL appear for the author at once, with focus moved to it, and for others on their next load. Empty or whitespace-only text and text over the limit SHALL be rejected with the reason and nothing stored.

#### Scenario: Start a thread
- **WHEN** a user submits "The install step is missing the database."
- **THEN** a new thread appears with that text, their name and the time

#### Scenario: Reply
- **WHEN** a user replies to a thread
- **THEN** the reply appears under the thread, indented one level

#### Scenario: Reply to a reply
- **WHEN** a user replies to a reply
- **THEN** the new comment is added to the same thread

#### Scenario: Invalid text
- **WHEN** a user submits only spaces, or text over 4,000 characters
- **THEN** the form shows why, keeps what was typed, and nothing is stored

### Requirement: Comment as the organization
The system SHALL let an admin choose, when posting or replying, to comment as the organization. Such a comment SHALL be shown with the organization's name and an "Organization" badge that does not rely on color alone, and SHALL remain attributable to the admin who wrote it for admins. Non-admins SHALL NOT be able to post as the organization, whatever they send. Any admin SHALL be able to edit and delete an organization comment.

#### Scenario: Admin answers officially
- **WHEN** an admin posts a reply with "Comment as the organization" chosen
- **THEN** the reply shows the organization name and the badge

#### Scenario: Option hidden for users
- **WHEN** a user with the `user` role opens the form
- **THEN** there is no option to comment as the organization

#### Scenario: Forged request
- **WHEN** a non-admin sends a request asking to post as the organization
- **THEN** it is refused with 403 and nothing is stored

#### Scenario: Another admin edits
- **WHEN** a different admin edits an organization comment
- **THEN** the edit is saved and the comment is marked as edited

### Requirement: How a comment is shown
The system SHALL show each comment's author name, the time (relative, with the exact time available), an "edited" marker when it was changed, and its text exactly as written with line breaks kept. An author's display name SHALL be the part of their email before the `@`, and admins SHALL additionally see the full email. A comment whose author no longer exists SHALL show the name it had when posted. Web addresses starting with `http://` or `https://` SHALL be shown as links that open without sending a referrer or granting the new page access to the portal; nothing else in the text SHALL be interpreted.

#### Scenario: Line breaks kept
- **WHEN** a comment contains two paragraphs
- **THEN** both are shown as written

#### Scenario: Markup is text
- **WHEN** a comment contains `<script>alert(1)</script>` or Markdown such as `**bold**`
- **THEN** it is shown literally and nothing is interpreted or run

#### Scenario: Links
- **WHEN** a comment contains `https://example.com/page`
- **THEN** it is a link that opens safely, and a `javascript:` address in the text is not a link

#### Scenario: Name and email
- **WHEN** an admin and a non-admin view a comment by `ana@example.com`
- **THEN** both see "ana" and only the admin can also see the full email

#### Scenario: Removed author
- **WHEN** the author's account has been removed
- **THEN** the comment still shows the name it was posted under

### Requirement: Edit and delete your own comments
The system SHALL let an author edit the text of their own comment (same rules as posting, marked "edited") and delete it. Only the author SHALL be able to edit a personal comment, including admins with respect to other people's comments. A deleted comment SHALL have its text removed from storage. A deleted comment with replies SHALL remain in the thread as "This comment was deleted"; a deleted comment without replies SHALL disappear.

#### Scenario: Edit
- **WHEN** an author edits their comment
- **THEN** the new text is shown with an "edited" marker

#### Scenario: Not yours
- **WHEN** a user tries to edit or delete someone else's personal comment
- **THEN** it is refused with 403 and nothing changes

#### Scenario: Delete with replies
- **WHEN** an author deletes a thread's first comment that has replies
- **THEN** the thread shows "This comment was deleted" in its place and the replies remain, and the original text is no longer stored

#### Scenario: Delete without replies
- **WHEN** an author deletes a comment that has no replies
- **THEN** it disappears from the page

#### Scenario: Admin cannot rewrite
- **WHEN** an admin tries to edit a personal comment of another user
- **THEN** it is refused with 403

### Requirement: Resolve threads
The system SHALL let a thread's author or any admin mark the thread resolved and reopen it. Resolved threads SHALL be collapsed by default with a visible "Resolved" state that does not rely on color alone and SHALL be expandable, and the count of open threads SHALL be shown. A new reply to a resolved thread SHALL reopen it.

#### Scenario: Resolve
- **WHEN** a thread's author marks it resolved
- **THEN** the thread is collapsed and labelled Resolved

#### Scenario: Others cannot resolve
- **WHEN** a user who is not the thread's author and not an admin tries to resolve it
- **THEN** it is refused with 403

#### Scenario: Reopen by reply
- **WHEN** a user replies to a resolved thread
- **THEN** the thread is open again

### Requirement: Comments follow document visibility and survive syncs
The system SHALL show and accept comments only for documents the visitor can see, using the portal's single visibility filter, so that blocking a repository hides its comments from every read and re-allowing it restores them. Comments SHALL be tied to the repository and the document path and SHALL survive syncs. When a document is deleted or moved in its repository, its comments SHALL remain stored but not be shown; if the same path returns, they SHALL reappear.

#### Scenario: Blocked repository
- **WHEN** an admin blocks a repository
- **THEN** its comments and counts are no longer returned by any page or API, and return when it is allowed again

#### Scenario: Document edited
- **WHEN** a sync updates a document's content
- **THEN** its comments are unchanged

#### Scenario: Document deleted and restored
- **WHEN** a document is removed from the repository and later added back at the same path
- **THEN** its comments are not shown while it is missing and are shown again once it returns

#### Scenario: Repository removed and re-added
- **WHEN** a repository leaves the installation and is added again
- **THEN** its stored comments are shown again for its documents

### Requirement: Limits against abuse
The system SHALL limit a user to 20 new comments per 10 minutes, SHALL limit a document to 1,000 stored comments (live and deleted placeholders), SHALL clean comment text of control characters and text-direction overrides before storing it, and SHALL answer exceeding a limit with 429 or 409 and a clear message. Writes SHALL require a same-origin JSON request.

#### Scenario: Posting too fast
- **WHEN** a user posts a twenty-first comment within ten minutes
- **THEN** it is refused with 429 and a message saying when they can post again

#### Scenario: Document full
- **WHEN** a document already has 1,000 comments
- **THEN** a new comment is refused with 409 and a message

#### Scenario: Cross-site write
- **WHEN** a write request arrives from another origin or without a JSON content type
- **THEN** it is refused and nothing is stored

#### Scenario: Hostile characters
- **WHEN** a comment contains control characters or right-to-left override characters
- **THEN** they are removed before storing

### Requirement: Accessible commenting
The system SHALL make the section usable with a keyboard and a screen reader: a labelled heading for the section, labelled text fields and buttons whose names identify the comment they act on, a status message announcing a posted, edited, deleted or failed action, focus moved to the new or changed comment, targets of at least 24 by 24 CSS pixels, and layout that works at every text size and at 320 CSS pixels wide, in both themes.

#### Scenario: Keyboard only
- **WHEN** a user posts, replies, edits, resolves and deletes using only the keyboard
- **THEN** every action is reachable and completes, and focus ends on a sensible element

#### Scenario: Announcement
- **WHEN** a comment is posted
- **THEN** a polite status message announces it and focus moves to the new comment

#### Scenario: Phone width
- **WHEN** the section is shown at 320 CSS pixels with the largest text size
- **THEN** there is no horizontal page scroll and nothing is clipped
