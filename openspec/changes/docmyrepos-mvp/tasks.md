## 1. Project scaffold

- [x] 1.1 The repo is already initialized by the maintainer (do not run `git init`, add remotes, or push); add `.gitignore` (including `.env`, `.env.*` except `.env.example`, `node_modules/`, `.next/`, `*.pem`, `.claude/dev-loop/`), `.editorconfig`, and `LICENSE` (MIT), and verify `git status` is clean after committing them
- [x] 1.2 Scaffold Next.js (App Router, TypeScript strict, pnpm, `src/` layout) and verify `pnpm dev` serves a placeholder page
- [x] 1.3 Add Tailwind v4 and base layout (header, container, footer) and verify styles apply on the placeholder page
- [x] 1.4 Add ESLint, Prettier, and `pnpm typecheck`/`lint`/`format:check` scripts and verify all pass on a clean tree
- [x] 1.5 Add Vitest with a sample test and verify `pnpm test` passes
- [x] 1.6 Add `docker-compose.yml` with a Postgres service and `.env.example`, and verify `docker compose up -d db` yields a reachable database

## 2. Configuration (config-and-sources)

- [x] 2.1 Define the zod schema for `docmyrepos.config.yml` (optional `repos` list, optional `exclude`, `docsPath` overrides, `defaults.docsPaths`; no org field) and verify unit tests for valid, invalid, and unknown-field configs
- [x] 2.2 Implement the config loader (YAML parse + env validation for `DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`, `SYNC_SECRET`) and verify tests show errors name the missing or invalid variable (including an unreadable PEM) without printing secrets
- [x] 2.3 Add a sample `docmyrepos.config.example.yml` and verify it passes the schema in a test

## 3. Database (foundation for sync, search, OKF)

- [x] 3.1 Add Drizzle and define `repos` (including `visibility` public/private), `documents`, `code_owners`, `sync_runs` tables per design, and verify `pnpm db:generate` emits a migration
- [x] 3.2 Add the weighted generated `tsvector` column + GIN index and `(repo_id, type)` index, and verify via SQL that inserting a row populates the vector
- [x] 3.3 Add `pnpm db:migrate`, a db client module, and a test helper for a throwaway test database, and verify migrations apply cleanly from empty
- [x] 3.4 Add an advisory-lock helper for per-repo sync serialization and verify a test shows a second concurrent acquire fails/waits

## 4. Parsing utilities (github-sync, okf-support)

- [x] 4.1 Implement frontmatter parsing preserving unknown keys and tolerating malformed YAML, and verify unit tests (valid, missing, malformed, only `type`)
- [x] 4.2 Implement title/description/heading extraction with the fallback order (frontmatter → first H1 → filename), and verify unit tests for each fallback
- [x] 4.3 Implement CODEOWNERS parser (comments, blank lines, multiple owners, teams, emails, escaped patterns) and verify unit tests including ordering
- [x] 4.4 Implement CODEOWNERS location precedence (`.github/` → root → `docs/`) and verify unit tests
- [x] 4.5 Implement docs-folder discovery (case-insensitive candidates, per-repo override) and verify unit tests including the no-docs case
- [x] 4.6 Implement OKF detection (`type` present in any doc or `okf_version` in docs root `index.md`) and reserved-file handling for `index.md`/`log.md`, and verify unit tests

## 5. GitHub sync engine (github-sync)

- [x] 5.1 Implement the GitHub client (Octokit, rate-limit backoff, ETag/conditional requests) and verify tests with mocked responses for 403 rate-limit and 404
- [x] 5.2 Implement the GitHub App installation token provider (`@octokit/auth-app`: mint from App id + private key + installation id, cache in memory, refresh shortly before expiry, one retry on 401) and verify tests with a fake clock and mocked token endpoint, including the "installation unavailable" error for uninstalled or suspended
- [x] 5.3 Implement repo discovery from the installation's accessible repositories, applying config narrowing (explicit list, `exclude`), skipping archived, and flagging listed-but-inaccessible repos as "not accessible by the GitHub App", and verify unit tests with mocked responses
- [x] 5.4 Implement tree fetch + tree-SHA short-circuit + doc file selection (extensions, size cap, ignored folders) and verify tests that an unchanged tree causes no blob fetches
- [x] 5.5 Implement bounded-concurrency blob fetching and diffing by blob SHA, and verify a test where one changed file triggers one fetch
- [x] 5.6 Implement persistence: upsert documents, delete missing paths, replace code owners, update README, repo metadata and `visibility`, and verify integration tests against the test database including a private-to-public change
- [x] 5.7 Implement per-repo status/error recording and `sync_runs` stats, and verify a failing repo does not stop others and keeps stored content
- [x] 5.8 Implement the end-to-end `syncRepo`/`syncAll` functions and verify an integration test against a fixture-backed fake GitHub (non-OKF repo + OKF repo)
- [x] 5.9 Handle removal of repos dropped from config, removed from the installation, or deleted on GitHub, and verify they disappear from queries

## 6. Triggers and webhooks (webhooks)

- [x] 6.1 Implement `POST /api/sync` guarded by the sync secret (all or one repo) and verify tests for authorized, unauthorized, and per-repo requests
- [x] 6.2 Implement `POST /api/webhooks/github` with raw-body signature verification using the App webhook secret, and verify tests for valid, invalid, and missing signatures
- [x] 6.3 Route events: `push` (default branch only), `repository` (renamed/deleted/archived/visibility), `installation_repositories` (add/remove repos), and `installation` (deleted/suspended -> error state, content kept); ignore unknown repos and branches; verify unit tests per event
- [x] 6.4 Make processing idempotent and coalesce concurrent syncs per repo, and verify duplicate-delivery and concurrent-request tests
- [ ] 6.5 Write the GitHub App setup guide in `docs/` (read-only permissions for contents and metadata, subscribed events, webhook URL and secret, App manifest, obtaining App id, private key and installation id, local tunnel) and verify the steps by registering and installing a test App

## 7. Markdown rendering (markdown-rendering)

- [x] 7.1 Build the unified pipeline (GFM, frontmatter stripping, heading slugs + anchors) and verify unit tests for tables, task lists, footnotes, anchors
- [x] 7.2 Add `rehype-sanitize` with an extended allow-list after all transforms, and verify XSS tests (`<script>`, `onerror`, `javascript:` links)
- [x] 7.3 Add server-side Shiki highlighting with dual themes plus copy button, and verify tests for known and unknown languages
- [ ] 7.4 Implement the link rewriting plugin (relative, bundle-root-absolute, GitHub blob fallback, broken links) and verify unit tests for each case
- [ ] 7.5 Implement image rewriting and `/api/asset/[owner]/[repo]/[...path]` (configured repos only, image content types, cache headers), and verify tests for path traversal, non-image, and token non-leakage
- [ ] 7.6 Tag ` ```mermaid ` blocks in the pipeline and build the client `MermaidDiagram` component (lazy import, strict security level), and verify a component test renders an SVG
- [ ] 7.7 Make Mermaid theme-aware (re-render on theme change) and add error fallback showing source + message, and verify a component test for each
- [ ] 7.8 Add the enlarge/pan view with keyboard close, and verify a Playwright test opens and closes it with Esc

## 8. Theming (theming)

- [ ] 8.1 Define light and dark CSS-variable design tokens and wire them into Tailwind, and verify both palettes render on the placeholder page
- [ ] 8.2 Add `next-themes` (light/dark/system, default system) with pre-paint script and the header toggle, and verify a Playwright test for system preference, persistence, and no flash
- [ ] 8.3 Check WCAG AA contrast for text, links, badges and code in both themes, and verify via an automated accessibility check (axe) in Playwright

## 9. Repo space UI (repo-space)

- [ ] 9.1 Implement data queries (repo list, repo by owner/name, docs tree, document by path) behind one shared visibility filter used by every repo, document, search, facet, and asset read, and verify integration tests including a test that flipping the filter to hide private repos hides them everywhere
- [ ] 9.2 Build the home page repo grid with search bar, private badge, empty state, and error state, and verify a Playwright test with seeded public and private data
- [ ] 9.3 Build the repo page shell with header (GitHub link, last synced) and not-found handling, and verify a Playwright test for known and unknown repos
- [ ] 9.4 Render the README section (using the pipeline) with an empty state, and verify a test for present and missing README
- [ ] 9.5 Build the code owners panel (grouped by owner, patterns, profile/team links, empty state), and verify a component test with the spec's example
- [ ] 9.6 Build the collapsible docs table-of-contents tree (ordered, titles, folder `index.md` summaries), and verify a component test with nested folders
- [ ] 9.7 Build the document page (rendered body, "on this page" outline, source link, prev/next, not-found), and verify a Playwright test navigating between docs

## 10. Search (search)

- [ ] 10.1 Implement the search query (`websearch_to_tsquery`, weighted ranking, `ts_headline` snippets, repo/type/tag/status filters, facet counts), and verify integration tests for ranking, empty results, and special-character queries
- [ ] 10.2 Strip markdown/HTML from snippets and verify a test with markup-heavy content
- [ ] 10.3 Build the `/search` page with results, highlights, facets, and URL-synced state, and verify a Playwright test for filtering and shareable URLs
- [ ] 10.4 Build the global `⌘K`/`Ctrl+K` command palette with live results and keyboard navigation, and verify a Playwright test

## 11. OKF support (okf-support)

- [ ] 11.1 Surface `is_okf`/`okf_version` in queries and show the OKF badge on cards and repo header, and verify a test that plain repos show no OKF UI
- [ ] 11.2 Build the type filter chips with counts on the repo TOC (hidden for non-OKF repos), and verify a Playwright test narrowing the tree
- [ ] 11.3 Add tag and status filters combinable with type, persisted in the URL, and verify a test for combined filters and reload restore
- [ ] 11.4 Build the OKF metadata card (type, tags, status, description, resource, sources, generated/verified, unknown keys), and verify component tests including `type`-only docs and unknown keys
- [ ] 11.5 Add deprecation/draft notices and `stale_after` warnings, and verify tests with past and future dates
- [ ] 11.6 Render `log.md` as a change log and keep `index.md`/`log.md` out of typed lists, and verify a test

## 12. Hardening

- [ ] 12.1 Add security headers including a Content-Security-Policy compatible with Mermaid and Shiki, and verify with a header test and no console violations in Playwright
- [ ] 12.2 Add sync status visibility (last run, errors) to the repo header and a small admin-free status route, and verify a test showing an errored repo
- [ ] 12.3 Add per-repo document-count and file-size caps with visible warnings, and verify a test that exceeding them is capped and warned
- [ ] 12.4 Add structured logging (no secrets) for sync and webhook paths, and verify tokens never appear in logs via a test

## 13. Deployment and open-source packaging (deployment-and-oss)

- [ ] 13.1 Write a multi-stage `Dockerfile` that runs migrations on start, and verify `docker build` succeeds and the container serves the home page
- [ ] 13.2 Complete `docker-compose.yml` (app + db) and verify `docker compose up` works from a clean checkout using `.env.example`
- [ ] 13.3 Add GitHub Actions CI (lint, typecheck, unit, e2e with a Postgres service, build) and verify a green run on a PR
- [ ] 13.4 Write `README.md` (quickstart, config, screenshots in light and dark), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates, and verify the quickstart works on a fresh clone
- [ ] 13.5 Write dogfood `docs/` in OKF (architecture with Mermaid, config, webhooks, search, OKF support), and verify DocMyRepos syncs its own repo and shows type filters

## 14. End-to-end acceptance

- [ ] 14.1 Run against a real GitHub App installation on an org (one plain-Markdown repo, one OKF repo, one private repo) and verify the home grid, private badge, README, code owners, TOC, and Mermaid diagrams all render
- [ ] 14.2 Push a doc change and verify the webhook updates the page within seconds; delete a doc and verify it disappears from TOC and search
- [ ] 14.3 Verify the full Playwright suite passes in light and dark themes and capture the screenshots for the README
- [ ] 14.4 Run `openspec validate docmyrepos-mvp` and confirm every spec scenario is covered by at least one test or documented manual check
