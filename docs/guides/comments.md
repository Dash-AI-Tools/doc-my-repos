---
type: Guide
title: Comments
description: How comments on documents work. Who can read, post, edit, delete and resolve, commenting as the organization, where comments are stored, what happens to them when a document moves, the limits, and how admins moderate or turn them off.
tags: [guides, comments]
status: stable
sources:
  - src/server/comments/service.ts
  - src/server/queries/comments.ts
  - src/lib/comments.ts
  - src/server/admin/comments.ts
  - src/server/config/schema.ts
generated: 2026-10-15
verified: 2026-10-15
stale_after: 2999-01-01
---

# Comments

Every document page has a **Comments** section below the document. It is where a reader says that a step is missing, a sentence is wrong or a question is unanswered, next to the text it is about, so the next reader sees it too. The comment count in the document header links to the section.

Comments belong to the portal. They are **stored in DocMyRepos' own Postgres database and never written to GitHub**: the GitHub App stays read-only, and nothing appears in the repository, its issues or its pull requests. They are not part of search, and they are not exposed through the MCP server.

## Who can do what

| Action                                   | Signed-in user | Admin                                  |
| ---------------------------------------- | -------------- | -------------------------------------- |
| Read comments on a document they can see | yes            | yes                                    |
| Start a thread, reply                    | yes            | yes                                    |
| Edit a comment                           | own comments   | own comments and organization comments |
| Delete a comment                         | own comments   | any comment                            |
| Resolve or reopen a thread               | own threads    | any thread                             |
| Comment as the organization              | no             | yes                                    |
| Use the admin Comments page              | no             | yes                                    |

Signing in is required to read and to write. A disabled user can do neither. An admin can delete another person's comment but cannot rewrite it: only the author edits a personal comment.

## Writing comments

- A comment is plain text of 1 to 4,000 characters. Line breaks are kept. Markdown and HTML are not interpreted: `**bold**` and `<script>` show exactly as typed.
- Web addresses that start with `http://` or `https://` become links that open in a new tab without sending a referrer. Nothing else becomes a link.
- Control characters and text-direction overrides are removed before the text is stored.
- Replies go one level deep. A reply to a reply joins the same thread.
- Posting needs script in the browser. Without script the existing comments are still readable.

### Name display

A comment shows the part of the author's email before the `@`, for example `ana` for `ana@example.com`. Admins also see the full email, which settles two people sharing a name. The name is copied into the comment when it is posted, so a comment keeps its author's name even after that account is removed.

### Commenting as the organization

An admin can tick **Comment as the organization** when posting or replying. The comment then carries the organization name (the name set in branding, or "Organization") and an "Organization" badge, so an official answer is told apart from a colleague's remark. Admins still see which admin wrote it, and any admin can edit or delete it. A request from a non-admin asking for this is refused.

### Edit, delete and resolve

An edit is marked "edited". Deleting a comment removes its text from storage. If the comment has replies, the thread keeps a placeholder, "This comment was deleted", so the replies still read; without replies the comment disappears.

The author of a thread or an admin can mark it **Resolved**. Resolved threads are collapsed and labelled in text, and the section shows how many threads are still open. A new reply reopens a resolved thread.

## Visibility, syncs and orphans

Comments are tied to the repository (by its stable GitHub id) and the document path, and they are read through the same visibility filter as the document. So:

- A comment is shown only where its document is shown. Blocking a repository hides its comments and counts from every page and API, and allowing it again brings them back.
- Syncs never touch comments. Editing a document leaves its comments as they are.
- When a document is deleted or moved in its repository, its comments stay stored but are not shown. They are **orphaned**. If a document returns at the same path, they reappear. The same holds for a repository that leaves the installation and is added back.

Nothing is deleted automatically, so orphans accumulate until an admin removes them. A moved document does not carry its comments to the new path.

## Limits

| Limit                 | Value                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| Comment length        | 1 to 4,000 characters                                                  |
| Posting rate          | 20 new comments per user in 10 minutes (the 21st is refused with 429)  |
| Comments per document | 1,000 stored, deleted placeholders included (more is refused with 409) |
| Write requests        | Same-origin JSON only; a request from another site is refused          |

A refused action says why, and the form keeps what was typed.

## Moderation

Admins have a **Comments** page in the admin area (`/admin/comments`, linked from the admin overview). It lists comments from all repositories, newest first, with the author's name and email, the repository and document, an excerpt, and a state:

- **Live**: shown on its document.
- **Deleted**: removed by its author or an admin, text already gone.
- **Orphaned**: its document or repository no longer exists.
- **Blocked**: its repository is blocked. These are listed for admins and marked.

Filter by state and by repository. An admin can delete any live comment, with the same effect as the author deleting it. The log records which admin deleted which comment, never its text.

Deleted and orphaned comments can be **permanently removed**, one by one or all the comments of a missing document at once, after a confirmation that states how many will go. Removal cannot be undone, and live comments on documents that still exist are refused.

## Turning comments off

Comments are on by default. To turn them off, untick **Allow comments on documents** under _Comments_ on **Admin > Workspace configuration** and save; no restart is needed. With comments off the Comments section and the count disappear from document pages and the comment APIs answer 404. Stored comments are kept, and they return when the setting is turned back on. The admin Comments page still opens, says comments are off and still allows permanent removal, which is how you clear them for good. See [Configuration](./configuration.md) for every setting.
