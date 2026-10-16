# Design

## Context

See `proposal.md` for the motivation and `specs/document-comments/spec.md` and `specs/comment-moderation/spec.md` for behaviour. Current state that shapes the approach:

- Documents live in `documents` (`repo_id` FK with cascade, unique `(repo_id, path)`) and repositories in `repos` (unique `github_id`, stable across GitHub renames). Sync deletes document rows that disappear from a repository and deletes the whole `repos` row when a repository is removed, archived or leaves the installation (`removal.ts`); an unarchived or re-added repository returns as a new row with a new `repos.id`.
- Every read of `repos`, `documents` and `code_owners` goes through `src/server/queries/` with `visibleRepos()` in the `WHERE`; each query is registered in `QUERY_FUNCTIONS`, `queries.test.ts` flips the filter on all of them, and `enforcement.test.ts` statically forbids reading the protected tables (a `PROTECTED_EXPORTS` list and an `ALLOWED_TABLE_ACCESS` allow-list of write sides) from anywhere else and bars `app/`, `components/` and `lib/` from the database layer.
- API routes are thin files calling handlers in `src/server/` (`admin/service.ts` for admin; `search-api.ts` as the model for JSON APIs: fixed errors, `no-store`, structured logs without content, in-process concurrency caps). Auth helpers: `getCurrentUser`, `requireUser`, `requireAdmin`, `authErrorResponse`. The session cookie is `HttpOnly; SameSite=Lax`; existing write routes do not check `Origin`.
- Users have only an email (`users.email`), a role and a `disabled` flag; there is no display name. The document page is a server component rendering `DocReader` / `ReaderGrid` with the article, `DocBreadcrumb` and `DocPager`; `DocumentDetail` carries `headings` and the path.
- Rendering untrusted text safely already has a precedent in `src/lib/okf-meta.ts` (`cleanText`: control characters, bidi overrides and zero-width marks removed, lone surrogates replaced, capped) and `safeExternalUrl` (only `http(s)` without credentials).
- Config is the zod-validated `docmyrepos.config.yml`; `mcp.enabled` (planned in `mcp-agent-access`) is the precedent for a feature switch.
- Other changes touch the same page: `responsive-docs-reader-layout` (working tree), `reading-accessibility` (`data-read-hide`, text size), `org-branding` (organization name from `getBranding`), `mcp-agent-access` (a different table and routes).

## Goals / Non-Goals

**Goals:**
- Comments that cannot be seen by anyone who cannot see the document, enforced in the one place visibility is enforced.
- Comments that survive syncs and repository churn and never leak into search, MCP or any other surface.
- Safe by construction: text-only, no HTML path from storage to the page.

**Non-Goals:**
- Anchoring to text (a passage moves or vanishes when the document is edited; the document path is the stable anchor), notifications, mentions, reactions, attachments, Markdown, edit history, real-time updates, comments on non-document pages, writing back to GitHub.

## Decisions

**1. Table `doc_comments`, keyed by GitHub repository id and path, with no foreign key to `repos` or `documents`.** Columns: `id bigint identity`, `github_repo_id bigint not null`, `path text not null`, `parent_id bigint null references doc_comments(id) on delete cascade`, `author_id integer null references users(id) on delete set null`, `author_label text not null` (the display name at posting time), `as_org boolean not null default false`, `body text not null`, `created_at`, `edited_at null`, `deleted_at null`, `deleted_by_admin boolean not null default false`, `resolved_at null`, `resolved_by integer null references users(id) on delete set null`. Indexes on `(github_repo_id, path, created_at)` and `(created_at desc)` for moderation. `check (parent_id is null or resolved_at is null)` and `check (char_length(body) <= 4000)`. Why not `repo_id` / `document_id` FKs: removal deletes those rows (`ON DELETE CASCADE` would delete the comments with them) and unarchiving or re-adding creates new ids; `repos.github_id` is stable, and the path is already the document's identity (`unique (repo_id, path)`). The cost is that "does the comment's document still exist" becomes a join, which the read already needs for visibility. `author_label` is a snapshot so removing a user does not rewrite history; the live name is never derived from a join to `users` (removed users have none). Hard deletion cascades from a root to its replies only through the explicit moderation action.

**2. Reads are in the query layer; writes are a new allow-listed module.** New queries in `src/server/queries/comments.ts`, each `(db, args, options?: QueryOptions)` and registered in `QUERY_FUNCTIONS`:
- `listDocComments(owner, name, path, { cursor, limit })` joins `repos` on `github_id` with `visibleRepos` **and** `documents` on `(repo_id, path)` so an orphan or hidden document yields nothing; returns roots (oldest first, 50 per page, cursor on `(created_at, id)`) with all of their replies, dropping deleted roots that have no live replies.
- `countDocComments` (live comments and open threads for the header link), and a batch variant is not needed now.
- `listCommentsForModeration` (admin only, `visibility: allowAllRepos` passed explicitly by trusted code after `requireAdmin`, like `getAdminRepos`): joins `repos` and `documents` with left joins to classify `live`, `deleted`, `orphaned` (no document row or no repo row) and `blocked`, with filters and paging.
- `getCommentTarget(id)` for permission checks (author, thread root, as_org, state), and `docIsVisible(owner, name, path)` reuses `getDocumentByPath`.
`doc_comments` is added to `PROTECTED_EXPORTS` and `PROTECTED_SQL_TABLES` in `enforcement.test.ts`; the write side lives in `src/server/comments/` (added to `ALLOWED_TABLE_ACCESS` with the reason: it writes and reads its own rows, never serves them to visitors, and checks document visibility through the query layer before every insert). `queries.test.ts` then proves the filter flip returns nothing for each new query. Alternative: put comments in `src/server/queries/` only and let the write side live there too (blurs the read-layer's purpose and its test assumptions).

**3. Writes are checked in one order.** Feature flag (404) → session (`requireUser`, 401; disabled users fail inside it) → same-origin check (`Origin` header, when present, must equal the request origin; `Sec-Fetch-Site` `cross-site` is refused; `Content-Type` must be `application/json`; 403) → body parse with zod (strict keys; `body` string; `parentId` number or absent; `asOrganization` boolean) → document visible via the query layer (404) → authorization for the action (author or admin as the spec says) → limits (per-user 20 per 10 minutes by counting `doc_comments` rows with `author_id` in the window, which works across instances without a cache; per-document 1,000 by `count(*)`; both inside the insert transaction with the document's `(github_repo_id, path)` advisory lock so two concurrent posts cannot exceed the cap) → clean text → write. The origin and content-type check is defense in depth on top of `SameSite=Lax`; it is added as a small shared helper (`requireSameOrigin`) for these routes and can be adopted by the other write routes later.

**4. API shape.** `GET /api/comments?repo=owner/name&path=…&cursor=…` (also used for "show more"), `POST /api/comments`, `PATCH /api/comments/[id]` with `{ body }` or `{ resolved }`, `DELETE /api/comments/[id]`, `GET /api/admin/comments?state=&repo=&cursor=`, `DELETE /api/admin/comments/[id]` (soft delete as admin), `POST /api/admin/comments/purge` with `{ ids }` or `{ githubRepoId, path }` for permanent removal (live comments on existing documents are refused). All answers are `no-store` JSON with fixed error codes. Logs record action, comment id, user id and outcome, never the text.

**5. Text handling.** Stored text is the cleaned input: `cleanText`-style removal of control characters (tab and line feed kept, CRLF normalized), bidirectional overrides and isolates, zero-width marks, lone surrogates; trimmed; 1 to 4,000 code points (counted by code point, not UTF-16 length). It is rendered by React as text in an element with `white-space: pre-wrap; overflow-wrap: anywhere`; the only markup produced is links: a small tokenizer finds `https?://` runs (no credentials, no trailing punctuation, max 2,048 characters, validated with `URL`) and emits `<a href rel="noopener noreferrer nofollow" target="_blank">` elements; there is no `dangerouslySetInnerHTML` anywhere in the feature (a test greps for it). The shared pieces (`cleanComment`, `linkify`) live in `src/lib/comments.ts`, pure and unit-tested with hostile strings.

**6. Display names.** `displayName(email)` is the local part of the email, falling back to the whole email if the local part is empty; it is computed at posting time into `author_label` and the full email is joined only for admin reads. Two users may share a name; the admin email resolves ambiguity. Organization comments store `as_org = true` and show the organization name read at render time from branding (so a rename shows everywhere), falling back to "Organization"; `author_label` still records the admin for the admin view.

**7. Rendering and the page.** The Comments section is a server component (`CommentsSection`) placed in the document column after the article body and before `DocPager`: it fetches the first page through `listDocComments`, renders the threads with static markup (readable without script), and mounts one client island (`CommentsClient`) that adds the composer, reply forms, edit-in-place, delete confirmation, resolve toggle, "show more" and the live status region. After a successful write the island updates its local state from the response (the API returns the changed comment/thread) and calls `router.refresh()` so the server view stays truthful; it does not poll. The header's count link (`#comments`) is rendered by the server from `countDocComments`. Resolved threads render in a native `<details>` (collapsed) with the state written as text. Everything uses design tokens (no new colors), works in both themes, and wraps at any text size.

**8. Configuration.** `comments: { enabled: boolean }` (default true) in the zod schema and `docmyrepos.config.example.yml`. The section component, the count link and the routes read it from the runtime config; disabled means 404 and no markup. The admin page still loads so stored comments can be purged.

**9. Retention.** Nothing is deleted automatically. Orphaned comments (a deleted or moved document) accumulate until an admin purges them from the Comments page; the page makes them easy to find and shows counts. A per-document cap and the per-user rate limit bound growth. A scheduled purge is deferred (see Open Questions).

**10. Moderation view.** A server-rendered page `/admin/comments` with state and repository filters (links, so it works without script), cursor paging, a row per comment with an excerpt (first 200 characters, cleaned), and client buttons for delete and for permanent removal with a confirmation naming the count. It reuses the existing admin layout and `requireAdmin` guard.

## Risks / Trade-offs

- [Orphans accumulate, and moved documents lose their comments] → Documented behavior; the moderation page surfaces orphans; a "move comments to another path" action is deferred until it is wanted.
- [Abuse: spam or harassment by signed-in users] → The audience is an organization's own signed-in users; per-user and per-document limits, admin deletion, and disabling the user (existing) are the tools. No anonymous access.
- [Stored text reaches other users' browsers] → Text-only rendering, link tokenizer with scheme allow-list, no HTML path, and a test that fails on `dangerouslySetInnerHTML` in the feature files.
- [Comment text is sensitive content from a possibly private repository] → Reads only through the visibility filter, never indexed, never in MCP or search, logs carry ids only; deleted comments are scrubbed from storage.
- [Cap races under concurrency] → Advisory lock per `(github_repo_id, path)` inside the insert transaction.
- [Display name collisions or leaking email local parts] → Local part only for non-admins; this is an internal portal where users are known to one another; documented in the README.
- [A removed repository's comments persist without being visible] → Intended (they return on re-add); admins can purge from the moderation page.
- [Same-origin check might break a proxy that rewrites `Origin`] → The check compares to the request origin derived the same way the rest of the app does and is skipped only when no `Origin` header is sent (non-browser clients); documented for reverse-proxy setups.

## Migration Plan

One additive migration (`doc_comments`). The feature is on by default and inert until someone comments; `comments.enabled: false` removes it. Rollback is turning it off, or dropping the table in a follow-up migration; no existing data is touched.

## Open Questions

- Whether to add a scheduled purge of orphaned comments after a retention period. It would be an extra setting and a job and does not change these specs or the task breakdown.
- Whether Markdown should be allowed in comments later (it would go through the existing sanitizing pipeline).
