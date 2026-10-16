# Proposal

## Why

Many repositories keep their HTTP API contract as an OpenAPI (Swagger) file next to their docs. Today the sync only reads `.md`/`.mdx`, so that contract is invisible in the portal: readers must leave for GitHub or a separate Swagger UI to see the endpoints that the Markdown docs talk about. When a repository has such a file, the portal should show it as an API reference alongside the rest of the documentation, and do nothing for repositories that have none.

## What Changes

- The sync detects OpenAPI/Swagger description files (OpenAPI 3.0 and 3.1, Swagger 2.0; YAML or JSON) in each repository. By default it looks for files named `openapi` or `swagger` (`.yaml`, `.yml`, `.json`) at the repository root and anywhere under the docs folder. A per-repository config option can list explicit paths instead.
- Detected specs are stored parsed (not rendered), synced incrementally by blob SHA like documents, removed when the file is removed, and kept when a sync fails. A file that is not a valid OpenAPI/Swagger document, is too large, or is over the per-repo cap is skipped with a sync warning, and never fails the sync.
- A repository that has at least one spec gets an **API reference** entry on its repository page, linking to a reference page per spec at `/<owner>/<repo>/api-reference/<path>`. That page shows the spec with the open-source **Swagger UI** widget (Apache-2.0), fed with the stored spec: endpoints grouped by tag, parameters, request bodies, responses, examples and schemas, with deep links to each operation. Each page also links to the spec file on GitHub.
- The widget runs **read-only and offline**: "Try it out" is disabled, it makes no network requests (the spec is passed in as data, external `$ref`s are not fetched, URL and config query parameters are ignored), and the site's Content Security Policy is not loosened. All text from the spec is untrusted.
- Repositories without a spec are unchanged: no empty section, no link.
- Not changed: search (specs are not indexed in this change), the home page card, the Markdown pipeline, and what counts as a document.

## Capabilities

### New Capabilities

- `api-reference`: detecting OpenAPI/Swagger files in synced repositories, storing them, and presenting them as a read-only API reference in the portal.

### Modified Capabilities

- None. The sync and browsing behaviour lives in the `docmyrepos-mvp` change specs (`github-sync`, `repo-space`, `markdown-rendering`), which are not yet archived into `openspec/specs/`. This change adds a new capability that extends them and does not rewrite their requirements.

## Impact

- Data: new `api_specs` table (one row per spec per repository) and a Drizzle migration; the sync selection fingerprint gains the spec rules, so each repository is re-planned once after deploy.
- Sync: `src/server/sync/tree.ts` (select spec files), `blobs.ts`, `engine.ts`, `persist.ts`, `removal.ts` and `warnings.ts` (fetch, store, remove, warn), plus a new parser module under `src/server/docs/` using the existing `yaml` dependency.
- Config: `src/server/config/schema.ts` and `docmyrepos.config.example.yml` (optional per-repository `apiSpecs` paths; spec size cap).
- Queries: new reads in `src/server/queries/` behind the visibility filter, registered in `QUERY_FUNCTIONS`.
- UI: a new route `src/app/[owner]/[repo]/api-reference/[...path]/page.tsx`, a client component that lazy-loads Swagger UI with a locked-down configuration and theme overrides, and an "API reference" entry on the repository page.
- Tests: parser and selection unit tests, sync integration tests against the test database, query visibility tests, widget configuration tests (no requests, no "Try it out"), and e2e plus axe in both themes under the real CSP.
- Docs: README and `DESIGN.md`.
- Dependencies: adds `swagger-ui-react` (Apache-2.0; its peer range covers React 19), loaded only on the reference page. Reuses `yaml` and the design tokens.
