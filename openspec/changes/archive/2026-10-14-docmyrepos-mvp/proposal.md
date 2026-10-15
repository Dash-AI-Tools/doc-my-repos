## Why

Teams keep valuable markdown documentation spread across many GitHub repositories, with no single place to browse, search, or see who owns what. DocMyRepos is an open-source web app that turns the `docs/` folders of an organization's repos into one searchable, well-rendered documentation portal, with first-class support for Open Knowledge Format (OKF) bundles.

## What Changes

- New Next.js + TypeScript web app (greenfield; the repository is empty).
- The app authenticates as a GitHub App installation (short-lived installation tokens, no personal access token). A YAML config file optionally narrows which repos the installation can see are shown; by default all of them are. No user login in the MVP (single-tenant).
- A sync engine reads each repo through the GitHub API, finds its docs folder, README, and CODEOWNERS, and stores parsed content in Postgres, including each repo's public/private visibility.
- The GitHub App's single webhook (`push`, `repository`, `installation_repositories`, `installation`) re-syncs affected repos and tracks which repos the installation can access, so content stays fresh.
- Per-repo space showing the main README, code owners, and a table of contents of the docs.
- Markdown viewer with GFM, syntax highlighting, link/image rewriting, and Mermaid diagrams.
- Global full-text search (Postgres FTS) with highlighted snippets and a `⌘K` palette.
- OKF support: detect OKF bundles, surface frontmatter metadata, and filter by `type` (plus tags and status).
- Light, dark, and system themes across UI, code blocks, and Mermaid diagrams.
- Self-hosting and open-source packaging: Docker, docker-compose, CI, license, contributor docs.
- Out of scope for the MVP: GitHub OAuth login, in-app repo picker, per-user private-repo permissions, multi-tenancy, editing docs in the UI.

## Capabilities

### New Capabilities
- `config-and-sources`: Config file and environment variables that declare the org, the repos to include, and per-repo docs-path overrides.
- `github-sync`: Discovering docs, README, and CODEOWNERS via the GitHub API, incremental diffing by tree/blob SHA, and persisting parsed documents.
- `webhooks`: Verified GitHub webhook endpoint and manual/scheduled sync trigger that re-sync repos idempotently.
- `repo-space`: Home page repo grid and per-repo page with README, code owners panel, and docs table of contents.
- `markdown-rendering`: Safe markdown-to-HTML pipeline with GFM, heading anchors, code highlighting, link/image rewriting, and theme-aware Mermaid diagrams.
- `search`: Full-text search across all synced docs with snippets, facets, and a global command palette.
- `okf-support`: OKF detection, frontmatter metadata display, and type/tag/status filtering.
- `theming`: Light, dark, and system themes without a flash on load.
- `deployment-and-oss`: Dockerfile, docker-compose, CI, license, and contributor documentation.

### Modified Capabilities
<!-- None: no existing specs. -->

## Impact

- New codebase: Next.js app (`src/app`, `src/components`, `src/server`), Drizzle schema and migrations, Docker and CI files, `docs/`.
- External dependencies: GitHub REST API via a GitHub App (read-only contents and metadata; rate limits apply per installation), Postgres, npm packages (Next.js, Drizzle, Octokit, unified/remark/rehype, Shiki, Mermaid, next-themes, zod, yaml).
- Operational: needs a public URL for webhooks (or a tunnel during development), and secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_PATH`), `GITHUB_APP_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`, `SYNC_SECRET`, `DATABASE_URL`. The operator must register and install the GitHub App once.
- Assumption: the project is released under the MIT license unless the owner chooses otherwise.
