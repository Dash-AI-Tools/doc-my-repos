# Proposal

## Why

The portal is where people read the documentation, but when they spot a gap, an error or a question, there is nowhere to say so on the page. The only channels are outside it (chat, issues in a repository they may not be able to see, email), so feedback gets separated from the document it is about, and the next reader never sees it. Comments should live on the page, inside DocMyRepos, visible to the people who can read that document.

## What Changes

- **Comments on a document.** Below each document, a "Comments" section where any signed-in user can start a thread and reply to others. Replies go one level deep. Comments are plain text (up to 4,000 characters), shown with the author, the time and an "edited" marker.
- **Users and the organization.** Any signed-in user can comment as themselves. An admin can also post **as the organization**: the comment carries the organization's name (from branding when `org-branding` is present, else "Organization") and an "Organization" badge, so an official answer is distinguishable from a colleague's.
- **Manage your own comments.** Authors edit and delete their own comments. A deleted comment that has replies stays as a placeholder ("This comment was deleted") so the thread still reads; its text is removed from storage.
- **Resolve threads.** The thread's author or an admin can mark a thread resolved or reopen it. Resolved threads are collapsed by default.
- **Stored in DocMyRepos, shown only where the document is visible.** Comments are stored in the portal's Postgres, not written to GitHub (the GitHub App stays read-only). They are tied to the repository and the document path and are read through the same single visibility filter as the document: a blocked repository's comments disappear with it and return when it is re-allowed. A comment survives syncs; if a document is deleted or moved in the repository, its comments stay stored but are not shown.
- **Moderation.** Admins get a **Comments** page listing recent comments across repositories (including orphaned ones whose document no longer exists), where they can delete any comment and permanently remove deleted or orphaned ones. Admins cannot edit other people's personal comments.
- **Guardrails.** Per-user posting limits, a cap per document, text-only rendering (no HTML, no Markdown), safe link handling, and the same-origin checks on every write.
- **An operator switch.** `comments.enabled` (default true) in `docmyrepos.config.yml`. When off, the section and the APIs disappear; stored comments are kept.
- Not changed: documents, search (comments are not indexed), sync, the MCP server (comments are not exposed to agents), roles and repository access rules. Not included: comments on a selected passage, notifications and email, @mentions, reactions, attachments, Markdown in comments, comment history, anonymous commenting, and comments on the repository or home pages.

## Capabilities

### New Capabilities

- `document-comments`: posting, replying, showing, editing, deleting and resolving comments on a document, commenting as the organization, visibility, content rules and limits.
- `comment-moderation`: the admin Comments page, admin deletion and permanent removal, orphaned comments, and the operator switch.

### Modified Capabilities

- None. The document page and the single visibility filter are specified in the `docmyrepos-mvp` change specs, which are not yet archived into `openspec/specs/`. Comments add a section to that page and reuse the filter; they do not rewrite those requirements.

## Impact

- Data: new `doc_comments` table and a Drizzle migration. Comments reference the repository by its stable GitHub id and the document by its path, with no foreign key to `repos` or `documents`, so sync removing and re-adding rows does not delete comments.
- Server: new reads in `src/server/queries/` (registered in `QUERY_FUNCTIONS`, joined with `visibleRepos`), new write handlers in `src/server/comments/` (allow-listed as a write side, each checking the document is visible through the query layer first), routes `GET`/`POST /api/comments` and `PATCH`/`DELETE /api/comments/[id]`, admin routes under `/api/admin/comments`. `enforcement.test.ts` is extended to protect the new table.
- UI: a `Comments` section on the document page (server-rendered list, client composer and actions), a comment count link in the document header, an `/admin/comments` page, a link from the admin overview.
- Config: `comments.enabled` in the zod schema and the example file.
- Coordination: the section is marked `data-read-hide` when `reading-accessibility` lands, uses the organization name when `org-branding` lands, and sits in the document column of `responsive-docs-reader-layout`. Each task re-reads the files it edits.
- Tests: unit tests for text cleaning and rendering, query and enforcement tests, handler and route tests for permissions and limits, component tests, and e2e plus axe in both themes.
- Docs: `README.md` (what comments are, who can do what, where they are stored, the switch) and a `docs/guides/` page.

## Assumptions

- "Users and organization" is read as: any signed-in user comments as themselves, and admins can additionally speak as the organization. If "organization" meant something else (for example comments by an external organization), this changes the author model only.
- "Live in DocMyRepos" is read as stored in the portal's database and not written back to GitHub.
- A user's display name is the part of their email before the `@` (users have no separate name). Admins see the full email.
