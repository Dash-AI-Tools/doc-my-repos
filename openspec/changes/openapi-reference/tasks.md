# Tasks

## 1. Parser and limits

- [ ] 1.1 Add small fixtures (OpenAPI 3.0 and 3.1 in YAML and JSON, Swagger 2.0, an invalid file, an alias bomb, a deeply nested file, an XSS-laden spec) and implement the pure `parseApiSpec` in `src/server/docs/openapi.ts` (JSON and YAML core schema, alias cap, acceptance rule, depth/node/operation caps, fixed reason codes, NUL/surrogate cleanup), and verify unit tests accept each valid format, reject each invalid case with the right reason, and finish the bomb fixtures quickly

## 2. Config and selection

- [ ] 2.1 Add per-repository `apiSpecs` (at most 10 normalized paths) and `limits.maxSpecBytes` (default 2 MB, lowerable only) to `src/server/config/schema.ts` and `docmyrepos.config.example.yml`, and verify config tests for valid, traversal, duplicate, too many and over-default values
- [ ] 2.2 Add API spec selection to `planTree` in `src/server/sync/tree.ts` (default root plus docs-folder name match, configured paths replacing the search, `node_modules` and hidden folders skipped, size/symlink/over-10 skips, never counted in the document cap), bump `SELECTION_RULES_VERSION` and add the spec settings to the fingerprint, and verify tree tests for each location, the override, skips, determinism and that changing only the spec settings re-plans

## 3. Storage and sync

- [ ] 3.1 Add the `api_specs` table to `src/server/db/schema.ts`, run `pnpm db:generate`, and verify the migration applies from empty and the unique `(repo_id, path)` and cascade delete are covered in the schema and constraint tests
- [ ] 3.2 Fetch spec blobs with the existing diff-and-fetch path, parse them, and upsert them in the same persistence transaction as the documents (`engine.ts`, `blobs.ts`, `persist.ts`), and verify sync integration tests for first sync, unchanged blob not refetched, edited spec updated, and a repo with no spec unchanged
- [ ] 3.3 Remove specs that were deleted, renamed away or became invalid (`removal.ts`), record fixed-reason warnings for invalid, oversized and over-limit specs (`warnings.ts`), and verify tests for deletion, an edit that breaks parsing (stored copy removed, sync succeeds), warning content, and that a failed sync keeps stored specs
- [ ] 3.4 Verify blocking then re-allowing a repository hides and restores its specs without a sync, and that two syncs of the same input leave `api_specs` identical (idempotence)

## 4. Queries

- [ ] 4.1 Add `listApiSpecs` (summaries without the `spec` column) and `getApiSpec` to `src/server/queries/`, join `repos` with `visibleRepos`, register both in `QUERY_FUNCTIONS`, and verify `queries.test.ts`/`enforcement.test.ts` pass and a flipped filter returns nothing
- [ ] 4.2 Add the spec summaries to `loadRepoPage` and a `loadApiReference` loader in `src/server`, with the same not-found and error states as the docs page, and verify loader tests for found, hidden, unknown path, and database error

## 5. Reference page

- [ ] 5.1 Spike first: add `swagger-ui-react` (latest release at least two weeks old, version pinned, `pnpm audit` clean), render a fixture spec in a throwaway page under the real CSP in a production build, and verify the browser console shows no CSP violations and no network requests; record in `design.md` whether `unsafe-eval`, `data:` images or fonts were needed (stop and re-plan if `unsafe-eval` is)
- [ ] 5.2 Build the `ApiReference` client component (lazy `next/dynamic`, `ssr: false`, `spec` as data, the locked-down configuration of decision 6, request interceptor that aborts everything, error boundary with the source link) and verify unit tests assert the exact options, that the interceptor rejects, that `url`/`configUrl` in the address are ignored, and that a throwing widget shows the fallback
- [ ] 5.3 Add the route `src/app/[owner]/[repo]/api-reference/[...path]/page.tsx` (visibility-filtered load, canonical-spelling redirect, `notFound()`, metadata, header with the "View source on GitHub" link, `<noscript>` notice), and verify page tests for ok, 404 for unknown and blocked, and the source link and noscript content
- [ ] 5.4 Show the API reference list on the repository page only when specs exist (title, API version, format and version, link), and verify the repository page tests for none, one and several specs
- [ ] 5.5 Add the scoped theme stylesheet mapping the widget to the design tokens in light and dark (no leakage outside `.api-reference`), and verify with screenshots and an axe pass in both themes and at phone width (no horizontal scroll, long paths wrap, method not shown by colour alone)
- [ ] 5.6 Verify the bundle: the production build output shows the widget only in the reference route's chunks, and the home, repository and document pages are unchanged in size

## 6. End to end and docs

- [ ] 6.1 Add a seed repository with a spec to the e2e stack (fake GitHub) and e2e coverage under the real CSP: the repo page lists it, the reference shows tags and operations, a deep link opens the operation, "Try it out" is absent, `?url=` and `?configUrl=` are ignored, an XSS-laden spec executes nothing, no CSP violation or network request appears in the console, a blocked repo answers 404, and a repo without a spec has no section; verify `pnpm test:e2e` passes
- [ ] 6.2 Document the feature in `README.md` (what is detected, config options, limits, read-only and offline, the dependency) and `DESIGN.md` (reference page and the themed widget), and verify the documented config example validates with the `docmyrepos.config.example.yml` tests
- [ ] 6.3 Run `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:e2e`, and `openspec validate openapi-reference`, and verify all pass
