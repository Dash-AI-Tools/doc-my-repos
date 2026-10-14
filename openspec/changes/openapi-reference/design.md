## Context

See `proposal.md` for the motivation and `specs/api-reference/spec.md` for the behaviour. Current state that shapes the approach:

- The sync (`src/server/sync/`) plans one recursive tree call per repo (`tree.ts`), selects `.md`/`.mdx` under the docs folder plus the root README and CODEOWNERS, diffs by blob SHA, fetches blobs (`blobs.ts`), and persists documents, removals and warnings in `persist.ts`/`removal.ts`/`warnings.ts`. The plan short-circuits when the tree SHA and a selection fingerprint (`SELECTION_RULES_VERSION` plus the settings) are unchanged.
- `documents` is Markdown-shaped: a generated `tsvector`, a 256 KB per-file cap (the config can only lower it), OKF facets, doc counts and the docs tree all read it.
- Pages read Postgres only, through the query layer and its single visibility filter (`visibleRepos`); `QUERY_FUNCTIONS` registers every query and `queries.test.ts`/`enforcement.test.ts` check that.
- Markdown from third-party repos is rendered at read time with a sanitizer (`src/server/markdown/`). The CSP is `script-src 'self' 'nonce-…' 'strict-dynamic'` and `connect-src 'self'`.
- `yaml` is already a dependency (frontmatter). Repo pages live under `src/app/[owner]/[repo]/`; the document route is `docs/[...path]`.
- A separate change, `responsive-docs-reader-layout`, is reworking the document page's navigation. This change must not depend on it.

## Goals / Non-Goals

**Goals:**
- Detect, store and display OpenAPI 3.0/3.1 and Swagger 2.0 files with the same guarantees as documents: incremental, idempotent, failure-tolerant, visibility-filtered, untrusted-input-safe.
- Zero impact on repositories that have no spec.

**Non-Goals:**
- "Try it out", authentication flows, or any request to the described API.
- Indexing specs in search or the command palette; a home-card badge; diffing versions; AsyncAPI, GraphQL schemas or Postman collections; resolving `$ref`s to other files or URLs.
- Editing or validating specs beyond what is needed to store and display them safely; writing our own spec renderer.

## Decisions

**1. A separate `api_specs` table, not rows in `documents`.** Columns: `id`, `repo_id` (FK, cascade), `path`, `blob_sha`, `size_bytes`, `format` (`openapi` | `swagger`), `spec_version` (`3.1.0`), `title`, `api_version`, `operation_count`, `spec` (jsonb, the parsed document), `created_at`, `updated_at`; unique `(repo_id, path)`. Alternatives: reuse `documents` with `type = 'openapi'` (it would enter search, the tree, doc counts and OKF detection, get a Markdown body it does not have, and hit the 256 KB cap and the tsvector limit); store only the raw text and parse on every request (repeats an expensive, attacker-controlled parse per view). Stored parsed, rendered at read time, matching "the sync stores parsed documents, not rendered HTML". `jsonb` also normalizes duplicate keys and rejects what Postgres cannot store, so strings go through the same NUL and surrogate cleanup as documents (`toDbJson`).

**2. Selection lives beside docs, not in them.** `planTree` gains `apiSpecs: PlannedFile[]` in `Selection`, chosen by a pure function: with configured `apiSpecs` paths, exactly those paths (normalized like `docsPath`; traversal and hidden-folder rules apply); otherwise files whose base name is `openapi` or `swagger` (case-insensitive) with `.yaml`/`.yml`/`.json` at the root or below the docs folder, skipping `node_modules` and dot-folders. They never count toward the document cap. Size over the spec limit, symlinks and over-limit counts become typed skips, reported through the existing sync-warnings channel with new fixed reasons. The spec rules, the configured paths and the size limit join the selection fingerprint, and `SELECTION_RULES_VERSION` is bumped, so every repo is re-planned once after deploy (one tree call each; unchanged blobs are not refetched). Alternative: also detect by sniffing any `.yaml`/`.json` for an `openapi:` key. Rejected: it would fetch every config file in a repo; the name convention plus an explicit config override covers real use.

**3. Fetch and persist like documents.** Spec blobs go through the existing diff-by-blob-SHA and bounded-concurrency fetch (`diffFiles`, `fetchBlobs`) as a second file set, and are written in the same persistence transaction as the documents so a repo is never half-updated. A spec that fails to parse is not stored; if a previous version was stored, it is deleted (the stored copy would no longer match the repo) and a warning says why. A GitHub or database error fails the sync as today and leaves everything stored. Removal and rename reuse the "stored but no longer selected" delete path. The implementer reads `engine.ts` and `persist.ts` for the exact hook points; the observable rules are in the spec.

**4. Pure parser with hard limits (`src/server/docs/openapi.ts`).** `parseApiSpec(text, path)` returns `{ ok, format, specVersion, title, apiVersion, operationCount, spec }` or `{ ok: false, reason }` with a fixed reason code. JSON uses `JSON.parse`; YAML uses the `yaml` package's core schema (no custom tags), a low `maxAliasCount`, `uniqueKeys`, and a prior size check. Afterwards one iterative walk enforces a nesting depth limit and node and operation caps, so alias "bombs" and absurd structures are rejected before storage. Acceptance rule: `openapi` string starting `3.` or `swagger` equal to `2.0`, an `info` object, and `paths` (or `components`/`webhooks` for 3.1). Title falls back to the file path.

**5. Swagger UI via `swagger-ui-react`, lazy-loaded on the reference page only.** A client component `ApiReference` is imported with `next/dynamic` (`ssr: false`) from the reference page, so the widget (a large bundle) is never part of any other page. It receives the stored spec object as a prop and passes it as `spec`, never as `url`. No server-side rendering of the operations: that is the cost of using the widget, and what replaces the earlier plan of our own server-rendered renderer and view model (removed from the tasks). Alternatives: our own renderer (subset coverage, much more code to maintain, but works without scripts and matches the design system exactly); Redoc or Scalar (nicer reading, but also script-driven and with their own style and CSP behaviour; Swagger UI is the widely recognised standard, which was the request); `swagger-ui` core without the React wrapper (fewer layers, but manual mounting and cleanup). The wrapper's peer range covers React 19. The pinned version is the latest release at least two weeks old at install time; `pnpm audit` must be clean for it.

**6. Locked-down configuration, enforced and tested.** The widget is configured only with: `spec` (the object), `supportedSubmitMethods: []` (no "Try it out"), `queryConfigEnabled: false` and no `url`, `urls` or `configUrl` (nothing is loaded from the address), `deepLinking: true` (operation anchors), `docExpansion: "list"`, `defaultModelsExpandDepth` small, `persistAuthorization: false`, `tryItOutEnabled: false`, `oauth2RedirectUrl` unset, and a `requestInterceptor` that aborts every request (so a relative or external `$ref` cannot cause a same-origin fetch of our own pages or APIs with the viewer's cookies). A configuration test asserts exactly these options and that the interceptor rejects. The widget's own Markdown sanitizing (DOMPurify) handles descriptions; our wrapper adds nothing that interprets spec text. The spec is the stored JSON, size-capped by the sync (2 MB), and reaches the page as part of the server-rendered payload; a wrapper `ErrorBoundary` shows a friendly error with the source link if the widget throws on a malformed-but-accepted spec.

**7. Content Security Policy stays as it is; verify first.** The policy (`src/lib/security-headers.ts`) is `default-src 'none'`, nonce plus `'strict-dynamic'` scripts, `style-src 'self' 'unsafe-inline'`, `img-src 'self' https:` (no `data:`), `font-src 'self'`, `connect-src 'self'`. Expected to work: lazy chunks load through `strict-dynamic`, inline styles are allowed, and no request leaves the page. Unknowns to settle in the first task, before anything else is built on it: whether Swagger UI needs `unsafe-eval` (if so, **stop and re-plan; the policy is not loosened to fit a widget**), and whether its CSS or icons use `data:` images, fonts or external assets (handled by CSS overrides; a route-scoped `img-src data:` is the only acceptable loosening and only if overrides cannot avoid it, decided with evidence from the spike and recorded here). The test is an e2e run under the real CSP with the console checked for violations.

**8. Reads through the visibility filter.** `listApiSpecs(db, repo)` (summaries without the `spec` column, for the repo page) and `getApiSpec(db, repo, path)` (one full spec) join `repos` with `visibleRepos(options)` like `listCodeOwners`, are registered in `QUERY_FUNCTIONS`, and are covered by the flipped-filter test. `loadRepoPage` adds the summaries; a new `loadApiReference` loads one spec.

**9. Route and layout.** `src/app/[owner]/[repo]/api-reference/[...path]/page.tsx`, dynamic, with the same canonical-spelling redirect and `notFound()` behaviour as the docs page. The server loads the spec through the visibility-filtered query and renders a small header (repository link, spec title, API version, format badge, "View source on GitHub" link built from the stored repository URL, default branch and spec path) and the `ApiReference` client component below it. A `<noscript>` block shows the notice and the source link. The repository page gets an "API reference" list in its sidebar column only when specs exist, each item linking to its reference page.

**9a. Theming.** Swagger UI ships a light theme only. A scoped stylesheet (`.api-reference .swagger-ui …`) maps its main surfaces, text, borders, method colours, inputs and code blocks to the design tokens so light and dark both work, flattening its shadows and rounding to fit the Swiss style, and keeping method names readable by text, not only colour. Scoped so it cannot leak into the rest of the site; every override is by class, never `!important` on the document. This is the main visual risk: the widget will look recognisably Swagger inside our shell.

**10. Config.** `docmyrepos.config.yml` gains an optional per-repository `apiSpecs: [path, …]` (zod, at most 10, normalized and validated like `docsPath`) and `limits.maxSpecBytes` (default 2 MB, may be lowered, not raised above the default), with the example file updated. No environment variables.

## Risks / Trade-offs

- [Swagger UI needs `unsafe-eval`, `data:` images or other things the CSP forbids] → Spike first (task 5.1) with the console checked under the real CSP. No `unsafe-eval` ever; a route-scoped `img-src data:` only with evidence it is unavoidable; otherwise the plan is re-opened, with our own renderer as the fallback.
- [The widget has had XSS and request-forgery issues driven by spec content and by query parameters] → Pinned recent release with a clean audit, no `url`/`configUrl`/query config, every request aborted, DOMPurify-sanitized Markdown, strict CSP as the backstop, hostile fixtures in unit and e2e tests, and a follow-up to keep the dependency current.
- [Pathological specs (alias bombs, giant schemas, huge operation counts)] → Size cap, alias cap, depth and node caps at parse time; the widget only ever receives what passed them; hostile fixtures in the tests. A very large accepted spec can still be slow to render in the browser; accepted, the size cap bounds it.
- [Large client bundle] → Lazy-loaded on the reference page only; checked with the build output that no other route imports it.
- [No server-rendered content: the reference needs JavaScript, is not indexable and is slower to first paint] → Accepted for a read-only internal portal; a notice and the source link cover the no-script case.
- [The widget looks different from the rest of the portal] → Scoped token mapping for both themes (decision 9a); accepted that it remains recognisably Swagger UI.
- [Name-based detection misses specs with other names (`api.yaml`, `petstore.json`)] → Config override lists exact paths; revisit sniffing if it proves common.
- [Operations are not searchable] → Accepted; a follow-up can index operations without changing this storage.
- [The one-time re-plan after deploy touches every repo] → One tree call per repo, no blob refetch for unchanged files; accepted.
- [`jsonb` storage of a 2 MB spec per file, also sent to the browser] → Bounded by the cap and 10 specs per repo; the repo page reads summaries only; the reference page sends one spec.

## Migration Plan

1. `pnpm db:generate` emits `CREATE TABLE "api_specs"`; `pnpm db:migrate` applies it. No existing data changes.
2. After deploy, the next sync of each repo re-plans (fingerprint change) and stores any specs it finds. Repositories without specs show nothing new.
3. Rollback: deploy the previous build, which ignores the table; dropping it is optional.

## Open Questions

None that change the specs or approach. Assumptions recorded: the default search is root plus docs folder by file name, the spec limit is 2 MB with at most 10 specs per repo, the reference is Swagger UI in read-only mode (no "Try it out"), and specs are not searchable in this change.
