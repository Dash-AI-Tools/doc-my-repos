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

This guide takes you from nothing to a portal showing your repositories' docs. The product overview and the full self-hosting notes are in the repository [README](../../README.md).

## Checklist

- [ ] Register a GitHub App and install it on your organization
- [ ] Copy `.env.example` to `.env` and fill in the values
- [ ] Start the stack with Docker Compose
- [ ] Sign in and enter the GitHub App settings
- [ ] Run the first sync
- [ ] Open the portal and try the search

## 1. Register the GitHub App

DocMyRepos authenticates as a GitHub App with read-only permissions, never with a personal access token. Follow [GitHub App setup](../github-app-setup.md). You end with three credentials (the App id, a private key and the installation id) and a webhook secret, which you enter in the app in step 4. A ready-made [App manifest](../github-app-manifest.json) is available for the manifest flow.

## 2. Configure the environment

```bash
cp .env.example .env
```

Set at least these variables in `.env`. The full list is in [Configuration](./configuration.md#environment-variables).

| Variable                        | Value                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `SETTINGS_ENCRYPTION_KEY`       | Encrypts the secrets you enter later. `openssl rand -base64 32`; back it up. |
| `SESSION_SECRET`                | A long random string that signs login sessions                               |
| `SYNC_SECRET`                   | A long random string that guards `/api/sync`                                 |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator (12+ character password); remove after first login   |

The GitHub App itself is not configured here: you enter it in the app after signing in (step 4).

## 3. Start the stack

Docker with Compose is the only requirement.

```bash
docker compose up -d --build --wait
```

This builds the image, starts the app and Postgres 17, and applies the database migrations on start. `--wait` waits for the health check, which answers `503` until the database and the startup settings are valid, so fill in `.env` first. The container log names any problem (`docker compose logs app`).

## 4. Enter the GitHub App and run the first sync

Open <http://127.0.0.1:3000> and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. You land on **Admin > Workspace configuration**, with a pop-up that lists these steps. Enter the App ID, installation ID, private key and webhook secret. Press **Test GitHub connection**: it reports how many repositories the installation can access. Save. The secrets are encrypted and never shown again, and no restart is needed.

The scheduler's startup sync ran before you entered the settings, so start the first sync yourself:

```bash
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" http://127.0.0.1:3000/api/sync
```

The answer is JSON with one entry per repository. Open <http://127.0.0.1:3000>: each repository with a docs folder appears as a card, and `⌘K` or `Ctrl+K` opens the search palette.

## 5. Narrow what is shown

By default every repository the App installation can access is synced. To narrow the set, open **Admin > Workspace configuration**, choose _Only these repositories_ (or _All except these_) and list one repository per line. Add `docsPath=user-guide` after a name to override that repository's docs folder.

See [Configuration](./configuration.md) for every setting.

## Sync this repository

This repository documents itself in `docs/`, as an OKF bundle. To see it in your own portal, install the App on the repository, add its name to the repository list (or leave the list out), and run a sync. It appears as an OKF repository with a type filter: Concept, Guide, Reference, Runbook and Decision. Background on the format is in [OKF support](./okf-support.md).

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
