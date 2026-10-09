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
A generated `tsvector` column with weights (title A, headings B, description/tags C, body D) and a GIN index, queried with `websearch_to_tsquery` (safe for arbitrary input) and `ts_headline` for snippets. Alternatives: SQLite FTS5 (simpler self-hosting but the user chose Postgres), external engines like Meilisearch (extra service, not needed at this scale). Drizzle is chosen over Prisma for transparent SQL and easy use of generated columns/GIN indexes.

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
- [FTS language assumptions] → Use the `simple`/configurable text-search config so non-English docs still match; make the config an env option.
- [OKF spec is young (v0.1 → v0.2)] → Tolerant parsing; no hard dependency on optional keys; record `okf_version` when declared.
- [Mermaid bundle size] → Dynamic import only when a diagram is on the page.

## Migration Plan

Greenfield: no data migration. Deploy by `docker compose up` (migrations run on start). Rollback is redeploying the previous image; schema changes ship as forward-only migrations, and because content is derived from GitHub, a full re-sync can rebuild the database if needed.
