# DocMyRepos

Open-source web app that syncs the `docs/` folders of a GitHub org's repos into Postgres and serves them as a searchable documentation portal. See `README.md` for the product description.

## Status

Planning only. There is no application code yet. The source of truth is the OpenSpec change `openspec/changes/docmyrepos-mvp/` (`proposal.md`, `specs/*/spec.md`, `design.md`, `tasks.md`). Read the relevant spec and the design decision before implementing anything.

## Workflow

- Work is driven by OpenSpec. Implement tasks from `tasks.md` in order, with `/opsx:apply`. Tick each `- [ ]` only after its stated verification passes.
- If behavior changes, update the spec under `openspec/changes/docmyrepos-mvp/specs/` first, then the code, then run `openspec validate --all`.
- Do not start implementing during `/opsx:propose` or `/opsx:update`; those only touch planning artifacts.

## Stack (decided)

Next.js App Router, React, TypeScript (strict), Tailwind v4, `next-themes`, Postgres with Drizzle ORM, `@octokit/rest`, `@octokit/auth-app` and `@octokit/webhooks`, unified/remark/rehype with `rehype-sanitize` and Shiki, Mermaid (client-side), zod, Vitest, Playwright, pnpm.

## Planned commands

These land with task group 1 and may need adjusting to what the scaffold actually provides.

```bash
pnpm dev                 # run the app
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e            # Playwright
pnpm db:generate         # create a Drizzle migration
pnpm db:migrate          # apply migrations
docker compose up -d db  # local Postgres
openspec validate --all
```

## Architecture rules

- Pages read from Postgres only. Never call GitHub at request time, except the image proxy `/api/asset`.
- The sync engine stores parsed documents (markdown body, frontmatter JSONB, headings, title, type, tags, status), not rendered HTML. Rendering happens at read time.
- Syncs are incremental (tree SHA, then blob SHA), idempotent, and serialized per repo. A failed sync keeps previously stored content.
- Search uses a generated weighted `tsvector` column and `websearch_to_tsquery`. Never build tsquery strings by hand from user input.
- Workspace settings (GitHub App, repository scope, limits, provider credentials) live in the database, are edited by admins, and are validated with zod when saved. Secrets among them are encrypted at rest with `SETTINGS_ENCRYPTION_KEY`, are write-only, and never reach logs or responses. Startup secrets (`DATABASE_URL`, `SESSION_SECRET`, `SYNC_SECRET`, the encryption key) come only from environment variables.
- GitHub access is a GitHub App installation (`@octokit/auth-app`), never a personal access token. Installation tokens are short-lived, cached, and refreshed. Repo discovery uses the installation's accessible repos, narrowed by config.
- Every read of repos, documents, search, facets, and assets goes through the single visibility filter in the shared query layer. Do not query those tables around it.
- Keep modules under `src/server/` free of React (the one allowed import is `cache` from `react`, to memoize a read per request) and under `src/components/` free of database access.

## Security rules

Docs come from third-party repos and are untrusted.

- Sanitize rendered HTML after all rehype transforms. Never render `.mdx` as executable MDX.
- Mermaid runs with `securityLevel: 'strict'`.
- GitHub credentials (App private key, installation tokens) never reach the browser, logs, or error messages. The App is read-only.
- `/api/asset` must validate the path is inside a configured repo and only serve image content types. Block path traversal.
- Verify webhook signatures (App webhook secret) against the raw request body. Guard `/api/sync` with `SYNC_SECRET`.

## OKF notes (spec v0.2)

- Only `type` is required in frontmatter. `type` is a free-form string: never hardcode a list of types, and never normalize case.
- Preserve and display unknown frontmatter keys. Tolerate missing fields and broken links.
- `index.md` and `log.md` are reserved. `index.md` summarizes a folder and `log.md` is a change log, so neither counts as a typed concept.
- A repo is OKF if any doc under its docs folder has a `type` key, or the docs-root `index.md` declares `okf_version`. Non-OKF repos show no OKF UI.
- The spec has no `docs/` convention. Docs folder discovery is our own, defaulting to `docs`, `doc`, `documentation`.

## Conventions

- Match the existing code style once code exists. Use TypeScript strict mode and avoid `any`.
- Write a test with each parser or pipeline change. Unit-test pure logic (CODEOWNERS, frontmatter, link rewriting), and use a real test database for sync and search.
- Both themes must work. Check any UI change in light and dark.
- Commits and PRs are authored by the user only: no Claude/Anthropic co-author trailers and no "Generated with" lines.
