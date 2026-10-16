---
type: Guide
title: Configuration
description: Every key of docmyrepos.config.yml, every environment variable, the sync limits and the background scheduler.
tags: [guides, configuration]
status: stable
sources:
  - src/server/config/schema.ts
  - src/server/config/env.ts
  - src/server/config/load.ts
  - docmyrepos.config.example.yml
  - .env.example
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Configuration

DocMyRepos has two sources of configuration:

- **`docmyrepos.config.yml`** narrows which repositories are shown and sets limits and the schedule. Everything in it is optional.
- **Environment variables** hold the secrets and the connection settings. Secrets are never read from the config file.

Both are validated with [zod](https://zod.dev) when the server starts. A problem is reported as a list of lines that name the file field or the variable, never its value. The home page shows the list, the logs carry it, and `GET /api/status` answers `503`.

## The config file

The file is `docmyrepos.config.yml` in the working directory, or the path in `CONFIG_PATH`. A missing default file means the defaults apply. A missing file named by `CONFIG_PATH` is an error. In Docker, mount your file and point `DOCMYREPOS_CONFIG` at it, as described in the [README](../../README.md).

```yaml
repos: # optional: only these repositories
  - api-service
  - name: web-app
    docsPath: documentation # per-repository docs folder override
  - name: payments
    apiSpecs: [api/v2/spec.yaml] # exact OpenAPI/Swagger files (at most 10)
exclude: [sandbox] # optional: every accessible repository except these
defaults:
  docsPaths: [docs, doc, documentation] # first match wins, case-insensitive
limits:
  maxDocsPerRepo: 2000
  maxFileBytes: 262144
  maxSpecBytes: 2097152 # OpenAPI/Swagger files
sync:
  intervalMinutes: 60
  onStartup: true
comments:
  enabled: true # false removes comments from document pages
```

| Key                     | Type                     | Default                        | Rules                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`                 | list of names or objects | all accessible repositories    | At least one entry. A name is a bare repository name without an owner. No duplicates, ignoring case. Cannot be combined with `exclude`.                                                                                                                           |
| `repos[].name`          | string                   | none                           | Letters, digits, `.`, `_`, `-`, up to 100 characters.                                                                                                                                                                                                             |
| `repos[].docsPath`      | string                   | none                           | Relative to the repository root, no `..`, no leading `/`. Authoritative: no fallback to the defaults when it is missing from the tree.                                                                                                                            |
| `repos[].apiSpecs`      | list of paths            | none                           | 1 to 10 exact file paths, relative, no `..`, no duplicates. They replace the default search for `openapi`/`swagger` files (`.yaml`, `.yml`, `.json`) at the root and under the docs folder. Specs are shown on a read-only reference page and are not searchable. |
| `exclude`               | list of names            | none                           | At least one entry. Cannot be combined with `repos`.                                                                                                                                                                                                              |
| `defaults.docsPaths`    | list of folders          | `docs`, `doc`, `documentation` | At least one entry. Tried in order, matched case-insensitively.                                                                                                                                                                                                   |
| `limits.maxDocsPerRepo` | integer                  | `2000`                         | 1 to 10000. More documents: the first ones in path order are synced, with a warning.                                                                                                                                                                              |
| `limits.maxFileBytes`   | integer                  | `262144`                       | 1024 to 262144 (256 KB). Larger files are skipped, with a warning.                                                                                                                                                                                                |
| `limits.maxSpecBytes`   | integer                  | `2097152`                      | 1024 to 2097152 (2 MB). Larger spec files are skipped, with a warning. At most 10 specs per repository.                                                                                                                                                           |
| `sync.intervalMinutes`  | integer                  | `60`                           | `0` (off) or 5 to 10080.                                                                                                                                                                                                                                          |
| `sync.onStartup`        | boolean                  | `true`                         | Run one full sync shortly after the server starts.                                                                                                                                                                                                                |
| `comments.enabled`      | boolean                  | `true`                         | `false` removes the Comments section and the comment APIs. Stored comments are kept. See [Comments](./comments.md).                                                                                                                                               |

The schema is strict at every level: an unknown key is an error, as is an empty list or a key with no value. The YAML is parsed as YAML 1.2 with duplicate keys rejected, at most 10 aliases and 32 levels of nesting.

### Which repositories are synced

The GitHub App installation is the upper bound: a repository the App cannot see is never synced, whatever the config says. The config only narrows the set.

- No `repos` and no `exclude`: every accessible repository.
- `repos`: only those names. A listed name the App cannot access is reported as `not accessible by the GitHub App`.
- `exclude`: every accessible repository except those.

Archived repositories are always skipped. Names are matched ignoring case. A repository that leaves the selection (dropped from `repos`, added to `exclude`, archived, or removed from the installation) is removed from the database on the next full sync; see the [removal rule](../architecture/sync-engine.md#removal-rule).

### When changes apply

The file is read when the server first needs it, and again on every `POST /api/sync`, so a changed `repos`, `exclude` or limit applies after the next manual sync. The `sync` block is read once when the scheduler starts, so changing it needs a restart. A file that is invalid at reload keeps the previous working configuration in place.

## Environment variables

| Variable                                                  | Required | Purpose                                                                                                              |
| --------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                            | yes      | A `postgres://` or `postgresql://` URL with a host (or a `host` query parameter for sockets).                        |
| `GITHUB_APP_ID`                                           | yes      | The numeric App id.                                                                                                  |
| `GITHUB_APP_INSTALLATION_ID`                              | yes      | The numeric id of the App's installation.                                                                            |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | one      | The unencrypted RSA key GitHub issued: inline PEM (real newlines or `\n`), or a file path. Setting both is an error. |
| `GITHUB_WEBHOOK_SECRET`                                   | yes      | The App's webhook secret, 16 or more characters. Verifies webhook signatures.                                        |
| `SYNC_SECRET`                                             | yes      | 16 or more characters. The bearer secret for `POST /api/sync`.                                                       |
| `CONFIG_PATH`                                             | no       | Path of the config file. Default `docmyrepos.config.yml`.                                                            |
| `LOG_LEVEL`                                               | no       | `debug`, `info` (default), `warn`, `error` or `silent`. An unknown value stops the app at startup.                   |
| `SYNC_SCHEDULER`                                          | no       | `1`, `true`, `on` or `yes` forces the scheduler on; `0`, `false`, `off` or `no` forces it off.                       |

Values are trimmed and an empty value counts as unset. The Docker image and the compose file add `SKIP_MIGRATIONS`, `DB_WAIT_SECONDS`, `APP_BIND`, `APP_PORT`, `DOCMYREPOS_CONFIG` and the `POSTGRES_*` settings. For tests there are `TEST_DATABASE_URL`, `SKIP_DB_TESTS`, `DATABASE_URL_E2E` and `E2E_SKIP_DB`. Never set `E2E_FIXTURES`: it turns the server into a database-less fixture server.

The private key never appears in logs, errors or responses. Prefer `GITHUB_APP_PRIVATE_KEY_PATH` with a read-only mounted file over the inline form.

## Scheduler

Webhooks keep content fresh. The scheduler is the fallback for deliveries that never arrive. It starts with the server and runs:

- one full sync about 10 seconds after start, when `sync.onStartup` is `true`;
- a full sync every `sync.intervalMinutes`, with 10 percent jitter;
- every minute, any per-repository syncs left waiting by a busy repository or a restart.

It is on when `NODE_ENV=production`, which the Docker image sets, and off in development, in tests and on the e2e fixture server. `SYNC_SCHEDULER` overrides that. With several replicas, only one runs a scheduled full sync at a time. The details are in the [sync engine](../architecture/sync-engine.md#scheduler) page.
