---
type: Concept
title: System overview
description: One Next.js app and one Postgres database. A sync engine copies parsed docs from GitHub into Postgres, and every page reads from Postgres only.
tags: [architecture, overview]
status: stable
sources:
  - packages/server/src/workspace.ts
  - packages/server/src/sync/engine.ts
  - packages/server/src/queries/visibility.ts
  - packages/server/src/queries/enforcement.test.ts
  - src/proxy.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# System overview

DocMyRepos is a single Next.js application (App Router, TypeScript) plus a Postgres database. It runs as one Node.js process. A GitHub App installation gives it read-only access to the repositories you choose.

![GitHub is read by the sync engine, which writes Postgres, which the pages read](../images/data-flow.svg)

Two rules shape everything else:

1. **Pages read Postgres only.** Nothing calls GitHub while you browse. The one exception is the image proxy `GET /api/asset/...`, which fetches a single image file.
2. **The sync engine stores parsed documents, not rendered HTML.** Markdown is rendered and sanitized when a page is requested, so a renderer fix needs no re-sync.

## Components

```mermaid
flowchart TD
  HOOK["GitHub webhook delivery"] -- "signed event" --> WH["POST /api/webhooks/github"]
  WH --> SYNC["Sync engine"]
  MAN["POST /api/sync"] --> SYNC
  SCH["Scheduler"] --> SYNC
  SYNC -- "tree, blobs, installation token" --> API["GitHub REST API"]
  SYNC -- "parsed documents" --> DB[("Postgres")]
  DB -- "visible rows" --> PAGES["Pages and /api/search"]
  PAGES --> READER["Reader's browser"]
  READER -- "image URLs" --> ASSET["GET /api/asset"]
  ASSET -- "one file" --> API
```

Three things start a sync: a verified webhook, a call to `POST /api/sync`, and the in-process scheduler. All of them run the same [sync engine](./sync-engine.md), which serializes work per repository.

## Request flow

This is what happens for a document page such as `/acme/handbook/docs/guides/setup`.

```mermaid
sequenceDiagram
  actor Reader
  participant Page as Next.js page
  participant Q as Query layer
  participant DB as Postgres
  participant MD as Markdown pipeline
  Reader->>Page: GET /acme/handbook/docs/guides/setup
  Page->>Q: getRepo, getDocumentByPath, getDocsTree
  Q->>DB: select with the visibility filter
  DB-->>Q: rows
  Q-->>Page: repository, document, table of contents
  Page->>MD: renderMarkdown with link context
  MD-->>Page: sanitized HTML
  Page-->>Reader: HTML with a per-request CSP nonce
  Reader->>Reader: Mermaid draws diagrams in the browser
```

The page reads three things: the repository, the document, and every document row of the repository. The rows give the sidebar tree, the previous and next links, the breadcrumb and the set of known paths that link rewriting needs.

## Modules

| Path                            | Responsibility                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/app/`                      | Routes: pages and the five API routes.                                                         |
| `packages/ui/src/components/`   | React components. They never touch the database.                                               |
| `packages/core/src/`            | Pure helpers shared by server and browser: URLs, search params, tree building, OKF display.    |
| `packages/server/src/sync/`     | The sync engine: discovery, tree planning, blob fetching, persistence, runs, scheduler.        |
| `packages/server/src/github/`   | The GitHub client and the App installation token provider.                                     |
| `packages/server/src/docs/`     | Pure parsers: frontmatter, titles and headings, OKF detection, CODEOWNERS, docs folder.        |
| `packages/server/src/markdown/` | The render pipeline: parse, link and image rewriting, highlighting, Mermaid tagging, sanitize. |
| `packages/server/src/queries/`  | Every read of repositories, documents, search and assets, behind one visibility filter.        |
| `packages/server/src/db/`       | Drizzle schema, migrations, advisory locks, the connection pool.                               |
| `packages/server/src/webhooks/` | Signature verification and the event router.                                                   |
| `packages/server/src/assets/`   | The image proxy.                                                                               |

Modules under `packages/server/src/` contain no React, and modules under `packages/ui/src/components/` contain no database access. A static test, `packages/server/src/queries/enforcement.test.ts`, fails when `src/app`, `packages/ui/src/components` or `src/lib` import the database layer, when `packages/ui/src/components` or `src/lib` import the query layer, or when code outside the sync write side reads the `repos`, `documents` or `code_owners` tables around the query layer.

## Trust boundaries

| Boundary                      | What crosses it                        | Control                                                                                   |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| GitHub to the app (pull)      | Repository lists, trees, file contents | Installation token, read-only permissions, held in memory only                            |
| GitHub to the app (push)      | Webhook deliveries                     | HMAC-SHA256 signature over the raw body                                                   |
| Operator to the app           | `POST /api/sync`                       | `Authorization: Bearer` with `SYNC_SECRET`, compared in constant time                     |
| Repository content to readers | Markdown, frontmatter, images          | Treated as untrusted: sanitized after all transforms, CSP with nonce, Mermaid strict mode |
| Reader to the app             | Page, search and image reads           | Signed-in users only; one visibility filter in the query layer                            |

The portal is behind a login. Any signed-in user can read every repository an admin has made visible, so make a private repository visible only if all your users may read it. The [security model](./security.md) lists each control and what it does not cover.

## Related

- Configuration keys and environment variables: [Configuration](../guides/configuration.md).
- Endpoint details: [HTTP API reference](/reference/api.md).
