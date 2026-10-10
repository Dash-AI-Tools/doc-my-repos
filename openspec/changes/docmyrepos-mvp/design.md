## Context

Greenfield project: `/Users/davidc/code/phdv/doc-my-repo` contains no code. See `proposal.md` for motivation and the `specs/` directory for required behavior. Constraints that shape the design:

- Docs come from third-party repositories, so content is untrusted and must be sanitized.
- GitHub's REST API is rate-limited per installation (5,000 requests/hour baseline, scaling up for larger orgs), so sync must be incremental.
- MVP is single-tenant with no viewer login; one GitHub App installation reads all repos it was granted. Anyone who can reach the app can read everything it has synced, so private repos imply a private deployment. The App's repository selection at install time is the access boundary.
- OKF v0.2 (GoogleCloudPlatform/knowledge-catalog `okf/SPEC.md`): only `type` is required, types are free-form, unknown keys must be preserved, `index.md`/`log.md` are reserved, links are plain markdown links. The spec defines no `docs/` folder, so docs discovery is our own convention.

## Goals / Non-Goals

**Goals:**
- Fast, SEO-irrelevant but snappy browsing of synced docs; server-rendered pages read from Postgres, never from GitHub at request time.
- Keep content fresh via webhooks, with a manual/scheduled fallback.
- Simple self-hosting: app + Postgres via compose.

**Non-Goals:**
- User accounts, per-user repo permissions, multi-tenancy (later milestone: GitHub OAuth).
- Editing docs, comments, or versioned/branch docs; only the default branch is shown.
- Building a general static-site generator or custom themes beyond light/dark.

## Decisions

**1. Next.js App Router + TypeScript, server components for read paths.**
Pages query Postgres directly; only interactive bits (theme toggle, Mermaid, filters, command palette) are client components. Alternatives: Astro (static-first, weaker for dynamic multi-repo app), Vite SPA + separate API (more moving parts).

**2. Postgres with Drizzle ORM and migrations; search via native full-text search.**
The target is Postgres 17: the compose `db` service, CI services, and test databases all use `postgres:17`, and the app assumes nothing newer.
A generated `tsvector` column with weights (title A, headings B, description/tags C, body D) and a GIN index, queried with `websearch_to_tsquery` (safe for arbitrary input) and `ts_headline` for snippets.
The text-search configuration is `simple`, fixed in the migration (exported as `SEARCH_TEXT_CONFIG`), and search queries call `websearch_to_tsquery('simple', ...)` and `ts_headline('simple', ...)` with the same regconfig so lexemes line up. `simple` is chosen because docs come from many repos in any language and the search spec makes no language or stemming promise: it lowercases and splits without stemming or stop words, so a word matches in every language, at the cost of `deploy` not matching `deployment`. It is not an environment option, because the vector is stored at write time and a runtime switch would silently mismatch queries against stored lexemes; changing it is a new migration that recomputes the column. Alternatives: SQLite FTS5 (simpler self-hosting but the user chose Postgres), external engines like Meilisearch (extra service, not needed at this scale). Drizzle is chosen over Prisma for transparent SQL and easy use of generated columns/GIN indexes.

**3. Sync stores the parsed doc, not raw GitHub responses.**
Per repo: one recursive tree call; compare tree SHA to skip; fetch only changed blob SHAs with bounded concurrency; delete rows for missing paths. Documents store body markdown, frontmatter JSONB, headings, and derived title/type/tags/status. Rendering happens at read time (cached) so renderer fixes do not require a re-sync. Alternative: store rendered HTML (faster reads, but stale on renderer changes and link rewriting depends on the full doc set).

**4. Sync runs are serialized per repo using a Postgres advisory lock (or a `sync_runs` row with a unique running guard).**
This gives idempotent webhook handling and coalescing without adding a queue service. Webhook responses return quickly and the sync runs in the background of the Node process. Alternative: a job queue (BullMQ/pg-boss) — deferred until sync duration or scale demands it; the sync function is written queue-agnostic.

**5. GitHub App as the credential, with one App-level webhook.**
The operator registers a GitHub App with read-only permissions (repository contents, metadata) and installs it on the org, choosing "all repositories" or a selection. The app is configured with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (inline PEM, or `GITHUB_APP_PRIVATE_KEY_PATH`) and `GITHUB_APP_INSTALLATION_ID`. `@octokit/auth-app` mints short-lived installation tokens; they are cached in memory and refreshed shortly before expiry, with one retry on a 401. Repo discovery uses the installation's accessible-repositories listing, narrowed by `docmyrepos.config.yml`, so no org name is needed in config. The App's single webhook URL receives `push`, `repository`, `installation_repositories`, and `installation` events, verified with `@octokit/webhooks` against the raw body. A protected `/api/sync` endpoint (secret header) plus an optional external cron call provides a reconciliation fallback.
Alternatives: fine-grained PAT (tied to one person's account, expires, no installation events, org webhook set up by hand — rejected); OAuth-only (needs viewer login, deferred). A single installation is supported in the MVP; multiple installations are a later extension.

**5b. Repository `visibility` column and one query chokepoint.**
`repos.visibility` (`public`/`private`) is stored on every sync. All reads of repos, documents, search, facets, and assets go through a shared query layer that applies a visibility filter. In the MVP the filter allows everything; later per-viewer access (GitHub OAuth) changes only this layer. Alternative: add the filter later per feature (rejected: easy to miss search counts or the asset proxy).

**6. Markdown pipeline: unified (remark → rehype) with `rehype-sanitize`, Shiki, and a custom rehype plugin for link/image rewriting.**
Sanitization runs after rewrite plugins and uses an extended allow-list. Shiki runs server-side with dual themes (CSS variables), so code blocks switch theme with no re-render. Alternatives: MDX (executes author code — rejected on security grounds; `.mdx` files are rendered as plain markdown), react-markdown (fine, but less control over server-side plugins).

**7. Mermaid renders client-side only**, lazy-imported when a diagram is present, with the Mermaid theme derived from the active theme and re-rendering on change. Invalid diagrams fall back to source + error. Mermaid's `securityLevel` is `strict`. Alternative: server-side render to SVG (needs headless browser; rejected).

**8. Link resolution uses the full path set for the repo.**
Relative and `/`-rooted (bundle-root) links resolve against the docs root; matches map to in-app routes, other repo files map to GitHub blob URLs, and missing targets render as broken without error. Images go through `/api/asset/...`, which fetches from GitHub with the server token, validates the path is inside a configured repo, restricts to image content types, and sets cache headers.

**9. OKF handling is data-driven.**
`type`, `tags`, `status` are columns on `documents` (indexed), populated from frontmatter regardless of OKF status; `repos.is_okf` is computed during sync. Type facets use `SELECT type, count(*) ... GROUP BY type` exactly as authored (no normalization). Reserved `index.md` provides folder summaries; `log.md` is excluded from typed lists.

**10. Theming with `next-themes` and CSS variable tokens**, with the theme script injected before paint to avoid flash. Tailwind v4 consumes the tokens; Shiki and Mermaid read the same state.

**11. Config via `docmyrepos.config.yml` validated with zod; secrets only via environment.**
Config is loaded once at startup (and re-read on `/api/sync`). Repo set changes remove stale repos from the DB on the next sync.

**12. Code owners are parsed to ordered rules (pattern + owners) and displayed grouped by owner.**
The panel shows rules as declared; no attempt to compute per-file ownership in the MVP.

## Data model

Defined in `src/server/db/schema.ts` (Drizzle, Postgres 17), driver `pg` (node-postgres).

- `repos`: `id`, `github_id` (unique), `owner` + `name` (unique together), `description`, `default_branch`, `archived`, `visibility` (enum `public`/`private`, not null, no default: the sync must supply GitHub's value, and `internal` from GitHub Enterprise maps to `private`, failing closed), `html_url`, `readme_path`, `readme_markdown`, `readme_sha`, `codeowners_path` and `codeowners_sha` (nullable, mirror the README pair; they hold the CODEOWNERS blob SHA so only a changed file is refetched even when there are zero rules and so no `code_owners` row), `tree_sha` (short-circuit), `docs_path` (folder in use, null when none), `is_okf`, `okf_version`, `sync_status` (`pending`/`ok`/`error`), `sync_error`, `last_synced_at`, timestamps. Removal rule: DELETE the repo row (cascading to documents and code owners) when it is absent from a successful full installation listing, dropped from config, or confirmed gone upstream. Mark `sync_status = error` with `sync_error` and KEEP stored content when the repo is still listed but the fetch fails, or the installation is suspended. NEVER delete on a listing failure, partial pagination, or a transient 404. A listed repo that has never been synced has no row, so "not accessible by the GitHub App" for it lives only in `sync_runs.results`.
- `documents`: `repo_id` (FK, cascade), `path` (unique per repo), `blob_sha`, `size_bytes`, `title` (not null, derived), `description`, `type` (nullable free-form text, case preserved, no enum), `tags` (`text[]`), `status` (nullable text), `headings` (JSONB), `frontmatter` (JSONB, all keys as authored), `body` (markdown), `reserved` (`index`/`log`/null), timestamps. The OKF keys `stale_after`, `generated`, `verified`, `resource`, `sources` stay in `frontmatter` only: they are display-only, never filtered or indexed, and untrusted and loosely typed, so a column would add parse failures for no query benefit. `type`, `tags`, `status` are columns because they are facets (decision 9).
  - `search_vector` (`tsvector`, `GENERATED ALWAYS ... STORED`, not null): `setweight` of `to_tsvector('simple', title)` A, the `text` of each `headings` entry via `jsonb_to_tsvector('simple', jsonb_path_query_array(headings, '$[*].text'), '["string"]')` B (slugs and depths are not indexed), `description` C, `tags` C, `body` D. Every input is `coalesce`d so a null field never nulls out the vector. `array_to_string` is only `STABLE` (some element types render per session settings) and Postgres rejects it in a generated expression, so tags go through `docmyrepos_immutable_array_to_string(text[], text)`, a `LANGUAGE sql IMMUTABLE PARALLEL SAFE` wrapper created by its own earlier migration; it is honest because it only accepts `text[]`, whose output depends on nothing but the arguments. Postgres computes the column on every insert and update and rejects explicit writes; Drizzle omits it from insert types. Drizzle has no per-column default exclusion for `select()`, so app queries other than search must list their columns rather than select whole `documents` rows.
  - Indexes: GIN on `search_vector`, btree on `(repo_id, type)`. No other facet indexes.
- `code_owners`: `repo_id` (FK, cascade), `position` (rule order, unique per repo), `pattern`, `owners` (JSONB array of `{handle, kind}` with kind `user`/`team`/`email`), `source_path` (which CODEOWNERS file was used). Grouping by owner happens at read time.
- `sync_runs`: `trigger` (`webhook`/`manual`/`schedule`/`startup`), `scope` (`owner/name` or null for all), `status` (`running`/`success`/`partial`/`failed`), `started_at`, `finished_at`, overall counters (repos total/synced/unchanged/failed, docs added/updated/removed/skipped), `results` (JSONB per-repo outcome: status, error, counts, skipped files, warnings such as malformed frontmatter), `error`. No FK to `repos`, so a run survives repo removal. Indexed on `started_at`.
- Search column caveats: (1) A `tsvector` cannot exceed 1 MB, and a document with enough distinct tokens (about 1.3 MB of unique tokens in testing) makes the INSERT fail. The per-file size cap (tasks 5.4 and 12.3) must therefore stay well below that (default 256 KB), and the sync treats a per-file write error as a skipped document with a warning in `sync_runs.results`, never as a failure of the repo's other documents. (2) Do not squash the migrations or use `drizzle-kit push`: `0001` is custom SQL (the immutable `array_to_string` wrapper) that the generated column depends on, and a single-shot generate emits the column without it. (3) The vector is large, so the query layer (task 9.1) lists the document columns it needs or omits `searchVector` with `getTableColumns` or the relational `columns: { searchVector: false }`; only search queries read it.

## Risks / Trade-offs

- [GitHub rate limits with many repos] → Tree-SHA short-circuit, blob-SHA diffing, conditional requests (ETag), concurrency cap, backoff to reset time; webhooks avoid polling.
- [Untrusted markdown/XSS] → Sanitize after all transforms, no MDX execution, Mermaid strict mode, strict image proxy with content-type allow-list, Content-Security-Policy header.
- [Single installation exposes private repos to anyone with app access] → Install the App on only the repos meant to be shown; document that private repos require a private deployment or network auth in front; per-viewer access via the visibility chokepoint plus GitHub OAuth is a planned follow-up. Credentials never reach the browser.
- [App private key leak] → Read from env or a mounted file, never logged or serialized in errors, never sent to the client; document rotation. Permissions are read-only, which limits the blast radius.
- [App uninstalled, suspended, or key rotated] → Surface a clear "installation unavailable" error state, keep stored content, and recover on the next successful sync.
- [App setup is more work than pasting a token] → Step-by-step guide and an App manifest in the docs.
- [Large repos / huge files] → Size cap per file, doc count cap per repo with a visible warning, skip vendored folders.
- [Webhook delivery lost] → Scheduled/manual full sync as reconciliation; short-circuited by tree SHA so cheap.
- [In-process background sync lost on restart/serverless] → Target Node server/Docker for the MVP (documented); the sync is resumable because it is incremental. Move to a queue if deploying serverless.
- [FTS language assumptions] → Use the language-neutral `simple` text-search config so non-English docs still match (decision 2). It is fixed in the migration, not an env option; no stemming is the accepted cost.
- [OKF spec is young (v0.1 → v0.2)] → Tolerant parsing; no hard dependency on optional keys; record `okf_version` when declared.
- [Mermaid bundle size] → Dynamic import only when a diagram is on the page.

## Migration Plan

Greenfield: no data migration. Deploy by `docker compose up` (migrations run on start). Rollback is redeploying the previous image; schema changes ship as forward-only migrations, and because content is derived from GitHub, a full re-sync can rebuild the database if needed.
