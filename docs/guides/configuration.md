---
type: Guide
title: Configuration
description: The settings an admin manages in the app (GitHub App, repositories, limits, sync, comments, Ask), the environment variables that remain, how secrets are protected, and the background scheduler.
tags: [guides, configuration]
status: stable
sources:
  - src/server/config/schema.ts
  - src/server/config/env.ts
  - src/server/workspace.ts
  - src/server/settings/store.ts
  - src/server/settings/crypto.ts
  - src/server/sync/schedule-runtime.ts
  - .env.example
generated: 2026-10-10
verified: 2026-10-16
stale_after: 2999-01-01
---

# Configuration

DocMyRepos has two sources of configuration:

- **Workspace settings**, managed by administrators in the app and stored in the database: the GitHub App, which repositories are shown, docs folders, limits, the sync schedule, comments, and Ask (limits and provider credentials). Secrets among them are encrypted at rest.
- **Environment variables**, a short list the server needs to start: the database connection, the session and sync secrets, the key that encrypts stored secrets, and a few switches.

Both are validated with [zod](https://zod.dev). A problem is reported as a list of lines that name the field or variable, never the value. Settings are checked when an admin saves them (an invalid save changes nothing); the environment is checked when the server starts.

## Workspace settings

Open **Admin > Workspace configuration** (`/admin/workspace`) for the GitHub App, repositories, limits, sync and comments, and the **Ask** tab of **Admin > Workspace configuration** (`/admin/workspace?tab=ask`) for the model provider. Only administrators can open them or call their APIs (`/api/admin/settings`, `/api/admin/ask`).

| Setting                    | Default                        | Rules                                                                                                                                                                                  |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App ID, Installation ID    | none                           | Positive whole numbers.                                                                                                                                                                |
| Private key (secret)       | none                           | Unencrypted RSA key in PEM text, pasted whole. See [GitHub App setup](../github-app-setup.md).                                                                                         |
| Webhook secret (secret)    | none                           | 16 or more characters, not a placeholder.                                                                                                                                              |
| Repositories shown         | all accessible repositories    | All, only a list, or all except a list. A list is never empty. Bare repository names (letters, digits, `.`, `_`, `-`, up to 100 characters), no duplicates.                            |
| `docsPath` of a repository | none                           | Relative to the repository root, no `..`, no leading `/`. Authoritative: no fallback to the defaults when missing.                                                                     |
| `apiSpecs` of a repository | none                           | 1 to 10 exact file paths, relative, no `..`, no duplicates. They replace the default search for `openapi` and `swagger` files.                                                         |
| Docs folder candidates     | `docs`, `doc`, `documentation` | At least one. Tried in order, matched case-insensitively.                                                                                                                              |
| Documents per repository   | `2000`                         | 1 to 10000. More documents: the first ones in path order are synced, with a warning.                                                                                                   |
| Largest document (bytes)   | `262144`                       | 1024 to 262144 (256 KB). Larger files are skipped, with a warning.                                                                                                                     |
| Largest API spec (bytes)   | `2097152`                      | 1024 to 2097152 (2 MB). Larger spec files are skipped, with a warning. At most 10 specs per repository.                                                                                |
| Full sync every (minutes)  | `60`                           | `0` (off) or 5 to 10080.                                                                                                                                                               |
| Sync on startup            | on                             | Run one full sync shortly after the server starts.                                                                                                                                     |
| Allow comments             | on                             | Off removes the Comments section and the comment APIs. Stored comments are kept. See [Comments](./comments.md).                                                                        |
| Ask limits                 | `100`, `20`, `1000`, `8`       | Questions per user per day (1 to 10000) and per ten minutes (1 to 1000), longest answer in tokens (100 to 8000), answers at once per process (1 to 100). See [Ask the docs](./ask.md). |
| Ask provider credentials   | none                           | Anthropic API key (secret). OpenAI-compatible base URL (`https`, or `http` on a loopback address) and key (secret), on the Ask page.                                                   |

The schema is strict at every level: an unknown field is an error, and so is an empty list. Setting both a repository list and an exclusion list is an error.

### Repositories synced

The GitHub App installation is the upper bound: a repository the App cannot see is never synced, whatever the settings say. The settings only narrow the set.

- **All accessible repositories** (the default): every repository the installation can access.
- **Only these**: only the listed names. A listed repository the App cannot access is reported as `not accessible by the GitHub App`.
- **All except these**: every accessible repository except those.

Archived repositories are always skipped. Names are matched ignoring case. A repository that leaves the selection (dropped from the list, added to the exclusions, archived, or removed from the installation) is removed from the database on the next full sync; see the [removal rule](../architecture/sync-engine.md#removal-rule).

### Secrets

The private key, the webhook secret and the provider keys are **write-only**. The pages show whether each is set and when it changed, never the value, a part of it or its length. Leave a field empty to keep the stored value, type a new one to replace it, or tick _Clear this value when I save_. They are encrypted with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY` before they reach the database, each bound to its own name, and they never appear in logs, errors or responses. A database backup alone does not reveal them.

If the key is missing or wrong, the admin pages and `/status` say so and name the affected secrets, the rest of the portal keeps working, and you enter the secrets again. **Back the key up with your database backups.**

### Changes apply

A saved change applies to the next sync, webhook delivery, image proxy request or question, with no restart. A sync or answer already running finishes with the settings it started with. Other server instances notice a change within about 5 seconds. An invalid save is refused and the previous settings stay in effect. Two admins editing at once cannot overwrite each other: the second save is refused with a message to reload.

The one exception is the background schedule (_Full sync every_ and _Sync on startup_): it is read when the server starts, so a change applies after a restart.

Every change is recorded with who made it and which fields changed (for a secret, only that it changed), never the values.

### Unconfigured and upgrading

A fresh install starts and serves. While the GitHub App is not configured, administrators see an info banner on the home page and the admin home. Clicking it opens `/admin/workspace` with a pop-up that lists the setup steps (the info button next to the page title reopens it any time). Nobody is redirected, and readers never see the banner. Until an admin enters the GitHub App, sync, webhooks and the image proxy report "not configured" (webhooks get a plain 401), and `/status` and the admin home name what is missing. The config file `docmyrepos.config.yml` and the variables `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`, `AI_ANTHROPIC_API_KEY`, `AI_OPENAI_BASE_URL`, `AI_OPENAI_API_KEY` and `CONFIG_PATH` are **no longer read and are not imported**. Enter their values in the admin pages, then remove them; `/status` and the startup log name any that are still present (names only). The steps are in the [README](../../README.md#upgrading-from-the-config-file-and-environment-variables).

## Environment variables

| Variable                        | Required | Purpose                                                                                                                                                      |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                  | yes      | A `postgres://` or `postgresql://` URL with a host (or a `host` query parameter for sockets).                                                                |
| `SETTINGS_ENCRYPTION_KEY`       | yes      | Base64 text that decodes to 32 or more bytes (`openssl rand -base64 32`). Encrypts the stored secrets. Without a valid one, secrets cannot be saved or read. |
| `SESSION_SECRET`                | yes      | 16 or more characters. Signs the login session cookie. Not a placeholder.                                                                                    |
| `SYNC_SECRET`                   | yes      | 16 or more characters. The bearer secret for `POST /api/sync`. Not a placeholder.                                                                            |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | no       | Bootstrap admin, created at first login while no users exist. Both or neither; the password has 12 or more characters.                                       |
| `LOG_LEVEL`                     | no       | `debug`, `info` (default), `warn`, `error` or `silent`. An unknown value stops the app at startup.                                                           |
| `SYNC_SCHEDULER`                | no       | `1`, `true`, `on` or `yes` forces the scheduler on; `0`, `false`, `off` or `no` forces it off.                                                               |

Values are trimmed, and an empty value counts as unset. The Docker image and the compose file add `SKIP_MIGRATIONS`, `DB_WAIT_SECONDS`, `APP_BIND`, `APP_PORT`, `APP_DATABASE_URL` and the `POSTGRES_*` settings; the tests use `TEST_DATABASE_URL`, `SKIP_DB_TESTS`, `DATABASE_URL_E2E` and `E2E_SKIP_DB`. Never set `E2E_FIXTURES`: it turns the server into a database-less fixture server.

## Scheduler

Webhooks keep content fresh. The scheduler is the fallback for deliveries that never arrive. It starts with the server and runs:

- one full sync about 10 seconds after start, when _Sync on startup_ is on;
- a full sync every _Full sync every_ minutes, with 10 percent jitter;
- every minute, any per-repository syncs left waiting by a busy repository or a restart.

It is on when `NODE_ENV=production`, which the Docker image sets, and `SYNC_SCHEDULER` overrides that. It starts even before GitHub is configured: its runs are skipped until the GitHub App settings are complete, and the first scheduled sync after that follows the interval, so start the first sync yourself with `POST /api/sync`. Details are in the [sync engine](../architecture/sync-engine.md#scheduler).
