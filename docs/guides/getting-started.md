---
type: Guide
title: Getting started
description: Run DocMyRepos with Docker Compose against your own GitHub organization, trigger the first sync, and set up a development environment on your machine.
tags: [guides, setup]
status: stable
sources:
  - docker-compose.yml
  - .env.example
  - package.json
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Getting started

This guide takes you from nothing to a portal showing your repositories' docs by hand. For a one-command install that also creates the GitHub App, see the [Install wizard](./install-wizard.md). The product overview and the full self-hosting notes are in the repository [README](../../README.md).

## Checklist

- [ ] Register a GitHub App and install it on your organization
- [ ] Copy `.env.example` to `.env` and fill in the values
- [ ] Start the stack with Docker Compose
- [ ] Run the first sync
- [ ] Open the portal and try the search

## 1. Register the GitHub App

DocMyRepos authenticates as a GitHub App with read-only permissions, never with a personal access token. Follow [GitHub App setup](../github-app-setup.md). You end with three credentials (the App id, a private key and the installation id) and a webhook secret. A ready-made [App manifest](../github-app-manifest.json) is available for the manifest flow.

## 2. Configure the environment

```bash
cp .env.example .env
```

Set at least these variables in `.env`. The full list is in [Configuration](./configuration.md#environment-variables).

| Variable                                                  | Value                                         |
| --------------------------------------------------------- | --------------------------------------------- |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`             | From the GitHub App                           |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | The App private key, inline or as a file path |
| `GITHUB_WEBHOOK_SECRET`                                   | The webhook secret, 16 characters or more     |
| `SYNC_SECRET`                                             | A long random string that guards `/api/sync`  |

## 3. Start the stack

Docker with Compose is the only requirement.

```bash
docker compose up -d --build --wait
```

This builds the image, starts the app and Postgres 17, and applies the database migrations on start. `--wait` waits for the health check, which answers `503` until the GitHub settings are valid, so fill in `.env` first. A running container with missing settings still serves pages, but the home page only says that the repositories could not be loaded; the container log names the missing settings (`docker compose logs app`).

## 4. Run the first sync

The scheduler also runs a full sync about 10 seconds after the server starts, but you can start one yourself:

```bash
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" http://127.0.0.1:3000/api/sync
```

The answer is JSON with one entry per repository. Open <http://127.0.0.1:3000>: each repository with a docs folder appears as a card, and `⌘K` or `Ctrl+K` opens the search palette.

## 5. Narrow what is shown

By default every repository the App installation can access is synced. To narrow the set, copy `docmyrepos.config.example.yml` to `docmyrepos.config.yml`, set `DOCMYREPOS_CONFIG=./docmyrepos.config.yml` in `.env`, and edit it:

```yaml
repos:
  - api-service
  - name: web-app
    docsPath: user-guide # override the default docs folder
```

See [Configuration](./configuration.md) for every key.

## Sync this repository

This repository documents itself in `docs/`, as an OKF bundle. To see it in your own portal, install the App on the repository, add its name to `repos` (or leave `repos` out), and run a sync. It appears as an OKF repository with a type filter: Concept, Guide, Reference, Runbook and Decision. Background on the format is in [OKF support](./okf-support.md).

## Develop on your machine

Development needs Node.js 22 or newer and pnpm, plus Docker for Postgres.

```bash
pnpm install
pnpm db:up        # Postgres 17 from docker compose, on 127.0.0.1:5432
pnpm db:migrate   # apply the migrations
pnpm dev          # http://localhost:3000
```

The background scheduler is off outside production, so `pnpm dev` never calls GitHub by itself. Trigger a sync with the `curl` command above, using the `SYNC_SECRET` from `.env`.

Before sending a change:

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm exec playwright install chromium   # once
pnpm test:e2e
```

The unit tests use a real Postgres. `pnpm db:up` provides it, and each test file creates and drops its own throwaway database. Set `SKIP_DB_TESTS=1` to skip the database tests on a machine without Postgres.

## Next steps

- Make content update on every push: [Webhooks](./webhooks.md).
- Understand what happens during a sync: [Sync engine](../architecture/sync-engine.md).
- Run it in production: [Operations](/reference/operations.md).
