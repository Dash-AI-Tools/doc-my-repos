# Changelog

All notable changes to DocMyRepos are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-29

### Added

- Public access: an admin can make repositories, or whole repository folders, readable
  without signing in. A visitor without a session sees the public repositories on the home
  page, reads their documents, API references and images, and gets a Sign in button in the
  header. Nothing is public until an admin marks it.
- Anonymous search (on by default once something is public) and anonymous Ask (off by
  default), configurable by admins. Anonymous Ask is limited by daily and ten-minute caps
  shared by all anonymous visitors; no question, answer or visitor address is stored or
  logged.
- Public switches on repositories and folders with a confirmation for repositories that are
  private on GitHub, and a Public access section in the workspace configuration.
- Events `repo.public_changed` and `folder.public_changed` for host apps.

### Changed

- Every image served by the image proxy is now `Cache-Control: private, max-age=300`, so a
  shared cache never keeps an image that depends on who asked.
- Database migration 0015 is additive: `is_public` on repositories and folders, an
  `anonymous` marker on Ask usage rows and a `public_access_settings` table.

## [0.1.0] - 2026-10-29

First public open-source release. Self-host with Docker: one searchable portal for the
documentation scattered across a GitHub organization's repositories.

### Added

- Sync of each repository's docs folder into Postgres (incremental by tree and blob SHA,
  idempotent, serialized per repository), with webhooks and a scheduled full sync.
- Per-repository space with README, CODEOWNERS, documentation tree, and full-text search
  across the organization (Postgres `tsvector`, facets, `Ctrl/Cmd+K` palette).
- GitHub-flavored Markdown with Shiki highlighting, Mermaid diagrams, sanitized HTML, and
  no executable MDX.
- OKF awareness: type, tag and status filters, metadata, notices and change logs when a
  repository uses Open Knowledge Format.
- OpenAPI / Swagger API reference pages discovered per repository.
- Comments on documents (signed-in users; admins can answer as the organization and moderate).
- Optional Ask the docs assistant with citations (operator brings the model).
- Read-only MCP endpoint for AI agents, with personal tokens that are shown once and can be
  revoked.
- Admin branding (name, title, colors, logo) and light / dark themes.
- Login with admin and user roles; workspace settings (GitHub App, repository scope, limits,
  provider credentials) stored encrypted in the database.
- `install.sh` one-liner installer (pulls the published image, writes a hardened compose file
  and `.env`, waits for health) with `--upgrade`, `--dry-run` and non-interactive flags.
- Multi-arch container image on GHCR (`linux/amd64`, `linux/arm64`), Docker Compose for the
  app plus Postgres 17, and a release workflow that publishes the image, npm packages and a
  GitHub Release with `install.sh` on each `v*` tag.
- Extension packages `@docmyrepos/core`, `@docmyrepos/server` and `@docmyrepos/ui` for host
  apps (`createApp` with hooks, adapters and plugins).

### Security

- Read-only GitHub App; credentials never reach the browser or logs.
- Image proxy path validation; webhook signature verification; `SYNC_SECRET` on `/api/sync`.
- Sanitized Markdown output; Mermaid `securityLevel: 'strict'`.
