# Design

## Context

See `proposal.md` for the motivation and `specs/public-access/spec.md` for the behavior. What exists today and constrains the approach:

- **The gate is two layers.** The proxy (`packages/server/src/proxy.ts`) runs at the edge with no database: it checks the session cookie's signature and redirects or answers 401. Behind it, `pageContext` (`packages/ui/src/page-context.ts`) and the route binder (`bind` in `packages/server/src/routes/index.ts`) confirm the user in the tenant's database through `ctx.user()` and `ctx.can("content.read")`. Routes marked `public` skip both.
- **Visibility is one filter.** Every shared query takes `options.visibility` (default `allowedReposOnly`, which is `is_allowed = true`), and `queries.test.ts` and `enforcement.test.ts` prove each query honors a flipped filter and that nothing reads the tables around it.
- **"Private" already means GitHub-private.** `repos.visibility` is `public | private` as GitHub reports it, shown as a badge. The new concept is different (readable without signing in), so it is named *public access* (`is_public` in the database) and never called "visibility" in code or UI.
- **Folders are admin groups of repositories.** `repos.folder_id` points at `repo_folders` (one folder per repository, optional), written only by admin actions, and kept across sync.
- **Ask is signed-in only.** `/api/ask` calls `access.user()` and `ask.use`, counts per user in `ask_usage` (counts and an outcome, no text) and holds a per-user and per-process concurrency gate.
- **Extension contract.** `authenticate` returns a user or null, and `authorize` decides a fixed action set for a user. The contract is versioned and covered by `api-report.json`.

## Goals / Non-Goals

**Goals:**
- An anonymous reader is a first-class reader of the one visibility filter, so every read path inherits the rule and nothing needs a second filter.
- Zero change for a workspace that marks nothing public: same responses, same redirects, same cost at the edge for the common case.
- A failure to apply the anonymous rule must fail closed (a login redirect or 401), never open.

**Non-Goals:**
- No new `authorize` actions, no change to the hook contracts, no per-visitor identity or tracking, no public comments, no public documentation sub-folders, no SEO files, no per-tenant branching: a host with many tenants gets the feature per tenant database for free, because the flags and settings live in each tenant's database.

## Decisions

### 1. A reader decides the filter; the default stays the strict one for members

Add `Reader = { kind: "member" } | { kind: "anonymous" }` and `filterFor(reader)`: members get `allowedReposOnly` as today, anonymous readers get a new `anonymousReposOnly`:

```
is_allowed AND (is_public OR folder_id IN (SELECT id FROM repo_folders WHERE is_public))
```

The page and route code that serves an anonymous reader builds the reader once per request (`readerOf(ctx)`) and passes `{ visibility: filterFor(reader) }` to every shared query it calls.

*Why not a required parameter on every query?* It would be the strongest guarantee, but it touches hundreds of test call sites for no new behavior. *Why not a request-scoped store (AsyncLocalStorage)?* An implicit reader is exactly how a forgotten call would leak, and the architecture here passes context explicitly. So the guarantee is a test: `enforcement.test.ts` gains a static rule that in the files that can serve an anonymous reader (home, repo, doc, API reference, search, Ask retrieval, asset serving) every call to a function of `QUERY_FUNCTIONS` passes `visibility`, and `queries.test.ts` runs every query with `anonymousReposOnly` flipped. The leak matrix (Decision 9) is the dynamic proof.

*Name clash:* the existing test-only filter `publicReposOnly` (GitHub-public) is renamed `githubPublicReposOnly` so the two are never confused.

### 2. Data model: three additive columns and one small table

`repos.is_public boolean not null default false` and `repo_folders.is_public boolean not null default false`, `ask_usage.anonymous boolean not null default false`, and a single-row `public_access_settings` table (Decision 4). One Drizzle migration, no backfill, no lock-heavy change. The previous image ignores the columns and the table, so rolling back works. Sync's explicit-column upsert never writes `is_public`, like `folder_id` and `is_allowed`. A subquery on `repo_folders` is cheap (a handful of rows) and keeps folder publicness a single source of truth: no copying a folder's flag onto its repositories.

### 3. The proxy lets possible-public paths through; routes decide

The proxy has no database, so it cannot know whether anything is public. It gains a pure, edge-safe `mayBePublicPath(pathname, method)` in `@docmyrepos/core` (next to `RESERVED_OWNERS`) that is true for `GET`/`HEAD` page paths that are the home page, `/search`, `/ask`, a repository or document path (an owner segment that is not reserved), plus `GET /api/search`, `GET /api/asset/**` and `POST /api/ask`. For those paths an anonymous request is passed on instead of redirected; every other path keeps today's cookie gate (including all admin, status, comments, token, account, plugin and machine paths). The decision then happens in code that can read the database:

- **Pages:** `pageContext(app)` keeps its signature and behavior. A new `readerContext(app, need)` (`need` = `content | search | ask`) returns `{ ctx, reader }`: a signed-in user is a member; otherwise the reader is anonymous only if the settings allow `need` and `anyPublic` is true, else it redirects to `/login`. Pages that can serve anonymous readers switch to it; no other page changes.
- **Routes:** the route table gets an `anonymous: "content" | "search" | "ask"` marker next to `public`, and `bind` applies the same rule: members as today, anonymous only if allowed for that need, else 401. Routes that are not marked are untouched.
- **Not found becomes a login redirect for anonymous readers:** `repoNotFound`, `docNotFound` and "access denied" outcomes call `deny(reader)`, which is `notFound()` for a member and `redirect("/login")` for an anonymous reader, so a missing repository and a non-public one are indistinguishable.

*Alternative rejected:* a cached public-path list in the proxy fed from the database (needs a database or a shared cache at the edge, and goes stale on every toggle).

*Cost:* anonymous requests to these paths now reach Node when nothing is public. Whether anything is public, and the settings, are read from the database on every such request (a `limit 1` read of the visible ids and one settings row), memoized only within the request. They are not cached across requests: in a Next.js server the pages and the route handlers are separate bundles, so no in-process cache could be cleared by the admin action that changes a mark, and "effective on the next request" would become "within the cache lifetime". A signed-in request never makes these reads. If the cost of anonymous traffic ever matters, the place to add a cache is the reverse proxy or a shared store, not this process.

### 4. Public settings get their own single-row table, like Ask's on/off

`public_access_settings` (`id = 1`, `search_enabled = true`, `ask_enabled = false`, `ask_questions_per_day = 200`, `ask_questions_per_ten_minutes = 20`, `updated_at`, `updated_by`) holds the settings, read and written by a `PUT /api/admin/public-access` route (admin only) that validates with zod (caps 1..10000 and 1..1000), audits by field name without values, and is read fresh on each request that needs it (Decision 3). The admin UI is a section on the existing Repository access tab.

*Why not the workspace config?* `configSchema` is a `strictObject`, so an image from before this change would reject a stored `publicAccess` key and report the whole workspace settings invalid, which would break the rollback in the plan below. `ask_settings` already sets the precedent: on/off switches that are not part of the config document live in their own row. The Ask switches stack: anonymous Ask needs `ask_settings.enabled`, a provider and `public_access_settings.ask_enabled`.

### 5. Admin actions extend the existing ones

`PATCH /api/admin/repos` accepts `isPublic`; the folder update route accepts `isPublic`. Making public anything that includes a GitHub-private repository (`repos.visibility = 'private'`) needs `confirmPrivate: true`; without it the route answers 409 `{ code: "confirm_private", privateRepos: n }` and writes nothing, and the UI asks the admin to confirm with that count. The folder case counts the allowed GitHub-private repositories currently in it. Turning a folder public later, after a private repository was moved into it, is not re-confirmed: the confirmation is about the moment of the action, and the folder row shows a "contains N GitHub-private repositories" note while it is public. Events (`onEvent`) are emitted for the toggles with the repository or folder id, never content.

### 6. Anonymous Ask: shared caps stored as counts, no identity

`/api/ask` resolves the reader like a page. For an anonymous reader it skips `access.user()` and `ask.use`, requires `publicAccess.ask`, keeps `requireSameOrigin`, and counts against shared caps with one query on `ask_usage`: rows with `anonymous = true` in the last day and last ten minutes. A row is inserted before the model call, as for members, with `user_id` null and `anonymous` true; it holds the provider, token counts and outcome, never text or an address. The extra column keeps anonymous rows distinct from rows of deleted users (also `user_id` null). The concurrency gate gets an anonymous entry that applies only the per-process cap (`maxConcurrent`), not the per-user "one at a time" rule, because there is no user. Over a cap the handler answers the existing 429 with `Retry-After` and the same fixed message. Retrieval passes `filterFor(anonymous)`, so excerpts come only from public repositories.

*Alternatives rejected:* per-address limits (need a trusted-proxy setting and an in-memory or shared store, and add an identifier to keep), and an in-memory counter (resets on restart and differs per instance). *Accepted trade-off:* any client can spend the shared budget; the caps bound the cost, and Ask is off by default.

### 7. UI for anonymous readers

The root layout gets the reader from `readerContext`-style resolution without redirecting: signed in shows the account menu, anonymous shows a **Sign in** link to `/login` (not on the login page itself), and plugin slots stay signed-in only. Components show comments, comment counts, the starred flag controls and the account menu only for members; the search bar, palette and Ask links show for anonymous readers only when `publicAccess.search` / `publicAccess.ask` allow it. The login page is unchanged and returns the user to the home page as today (returning to the page they came from is a non-goal here).

### 8. The home page for an anonymous reader

`getHomeData` takes the reader. Folder sections are built only from folders where `repo_folders.is_public`; a public repository in a non-public folder is listed with the folderless repositories and carries no folder id, name or description in what the page receives, so the folder is not revealed. Admin starring and ordering apply to what is visible.

### 9. Proof

- **Leak matrix** (contract test, real Postgres): a workspace with one public repository, one public folder with a repository, one GitHub-private repository marked public, one blocked public repository and one plain repository; an anonymous client requests every page, read API and image URL and the test asserts the public set is served, everything else redirects or answers 401 with identical bodies for "missing" and "not public", and the plain repository's name, documents, counts, facets, images and Ask excerpts appear nowhere.
- **Fail closed:** tests for a broken workspace read, a missing settings row and a database error on the anonymous path (each ends in a login redirect or 401, never content).
- **Default unchanged:** the existing e2e suite runs unchanged against an empty public set, and a test shows `/` redirecting for an anonymous visitor.
- **UI:** e2e for the Sign in button, the admin switches and confirmation, anonymous search and Ask (fake provider), in light and dark and at phone width.
- **Contract:** `api-report.json` and a minor changeset for the changed exported types; the hook contract suite still passes unchanged.

## Risks / Trade-offs

- **A missed call site leaks private content to anonymous readers** → the static rule in `enforcement.test.ts`, `anonymousReposOnly` run through every query, and the leak matrix; default for unmarked routes is the signed-in rule.
- **Anonymous traffic now reaches Node and the database** → two small indexed reads per anonymous request to a path that may be public (none for signed-in requests), the same indexed reads as signed-in users otherwise, and the cost of public content is the admin's explicit choice.
- **Publishing something by accident (a GitHub-private repository, or one moved into a public folder)** → confirmation on the toggle with the count, a standing note on a public folder that holds private repositories, and an audit event for each change.
- **Shared Ask budget can be drained by anyone** → conservative defaults, off by default, caps checked before the model call, and no per-visitor state to defend.
- **Response caches serve one viewer's page to another** → pages are already dynamic (per-request nonce); the search and Ask routes already answer `no-store`, and the image proxy, which marked images of GitHub-public repositories `public`, now answers `private, max-age=300` for every image (a shared cache could otherwise keep an image a signed-in user fetched and hand it to an anonymous visitor after the repository stopped being public). The leak matrix asserts the headers.
- **Anonymous images drive GitHub calls** → the image proxy is the one place a request reaches GitHub. An anonymous request gets there only for an image of a public repository, after the visibility check, and goes through the same in-memory cache, fetch gate and size and type limits as a signed-in one, so the cost is bounded the way it is today.
- **Hosts relying on "signed out sees nothing"** → unchanged unless an admin marks something public, and a host that wants to veto can leave the flags false; a later change can add `authorize` actions if a host needs to decide it per tenant (recorded as a non-goal, not an open question).

## Migration Plan

1. Deploy the image: the migration adds three columns with defaults and one table with a default row; no data changes and no behavior changes while nothing is public.
2. An admin marks repositories or folders public, and optionally turns on public Ask.
3. Rollback: deploy the previous image. Its code ignores the new columns and table, its settings document is untouched (so it stays valid under the strict schema), and it again shows nothing to anonymous visitors, which is the safe direction. Marks and settings are kept and apply again when the new image returns.
