---
type: Runbook
title: Operations
description: Health checks, the structured log format and LOG_LEVEL, and what to check and do for the problems an operator meets. Failed syncs, missing repositories, webhooks that never arrive, backups and upgrades.
tags: [reference, operations, runbook]
status: stable
sources:
  - src/server/log.ts
  - src/server/status-api.ts
  - src/server/sync/runs.ts
  - Dockerfile
  - docker-compose.yml
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2027-06-30
---

# Operations

This page is for whoever runs a DocMyRepos instance. Deployment itself (Docker, the reverse proxy, secrets) is covered in the repository [README](../../README.md). Review this runbook when the code changes how it reports problems.

## Health

`GET /api/health` is the health check. It needs no login and returns only the verdict: `200 {"status":"ok"}` means the app and its database answer. `503` with `{"error":"unavailable"}` means the database or the configuration is unusable. A failed repository sync does not change the status code. `GET /api/status` has the sync details, but it lists repositories and needs a login (a session cookie), so an anonymous `curl` gets `401`:

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -b 'dmr_session=<session cookie>' http://127.0.0.1:3000/api/status | jq '{summary, lastRun: .lastRun.status}'
```

The Docker image checks it every 30 seconds with a 5 second timeout and a 90 second start period. `docker compose up --wait` waits for that check, so with missing GitHub settings it ends unhealthy. The `/status` page shows the same data for people: the last run and every repository's state, errors and warnings. The full body is in the [HTTP API reference](./api.md#get-apistatus).

## Logs

The server writes one JSON object per line: `debug` and `info` to stdout, `warn` and `error` to stderr. In Docker they are already on the container streams, and compose rotates them (3 files of 10 MB).

```json
{
  "ts": "2026-10-10T12:00:00.000Z",
  "level": "info",
  "service": "docmyrepos",
  "event": "sync.run.finished",
  "trigger": "webhook",
  "status": "success",
  "durationMs": 812
}
```

`ts`, `level`, `service` and `event` are always present; the other fields depend on the event. Event names are stable and dotted (`area.subject.verb`), so alert on them, not on text. `LOG_LEVEL` sets the threshold: `debug`, `info` (default), `warn`, `error` or `silent`. An unknown value stops the app at startup with a configuration error naming `LOG_LEVEL`. Keep it at `info` or above in production: unchanged repositories, tree short-circuits, retries and served images are `debug` only.

| Family             | Events                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `sync.run.*`       | `started`, `finished` (level `warn` unless the status is `success`), `error`, `reaped`, `not_run`.         |
| `sync.repo.*`      | `done` (`warn` when the repository failed, `debug` when unchanged), `removed`, `replan`.                   |
| `sync.discovery.*` | `done`, `failed`: the installation listing.                                                                |
| `sync.request.*`   | `done`, `coalesced`, `rerun`, `rearmed`: single-repository requests and the rerun marker.                  |
| `sync.scheduler.*` | `started`, `stopped`, `disabled`, `config_invalid`; `sync.schedule.*` for each tick.                       |
| `github.*`         | `token.minted`, `token.mint_failed`, `installation.unavailable`, `rate_limit.wait`, `rate_limit.exceeded`. |
| `webhook.*`        | `received`, `signature`, `rejected`, `decision`, `task.finished`, `task.failed`.                           |
| `sync_api.*`       | `auth`, `done`, `failed`, `config_invalid`: the manual endpoint.                                           |
| `asset.*`          | `upstream_failed`, `failed`; `served` at `debug` only.                                                     |
| `*.load_failed`    | A page or route could not read its data. The `reason` is a kind, such as `ConfigError`.                    |

What is never logged: the App private key, installation tokens, App JWTs, the webhook and sync secrets, the database password, request headers and bodies, webhook payload content, and error messages or stacks. Only an error's name, kind, SQLSTATE or OS code and HTTP status are logged. Webhook lines carry GitHub ids, never repository names, because a sender controls those. As a safety net the logger also redacts credential-like keys and scrubs token shapes from text.

## Runbook

| Symptom                                          | Check                                                                                                                     | Action                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home page shows a configuration error            | The problem lines name the variable or config field, never its value. `GET /api/health` answers `503`.                    | Fix `.env` or the config file and restart. A bad config file at `POST /api/sync` keeps the previous one.                                                                    |
| Container is unhealthy                           | `docker compose logs app` for `status_api.failed` and `sync.scheduler.config_invalid`.                                    | Usually missing GitHub settings or an unreachable database. Fix and restart.                                                                                                |
| A repository shows the error state               | The `/status` page or `repos[].syncError` in `/api/status`. Messages are fixed texts.                                     | Stored content is kept. Fix the cause, then `POST /api/sync` with `{"repo":"name"}`.                                                                                        |
| A repository is missing from the portal          | Is it in the App installation? In `repos` or `exclude`? Archived? Does it have a `docs`, `doc` or `documentation` folder? | See [Configuration](../guides/configuration.md#which-repositories-are-synced). Add it to the installation and sync.                                                         |
| Pushes do not update the portal                  | GitHub App, Advanced, Recent Deliveries: the status code of each delivery.                                                | `401` secret mismatch, `415` wrong content type, `500` missing secret. See [Webhooks](../guides/webhooks.md). The scheduled sync repairs missed pushes within the interval. |
| Repositories say the installation is unavailable | The App was uninstalled or suspended. Content is kept.                                                                    | Reinstall or unsuspend. The `unsuspend` and `created` events start a full sync, or run one yourself.                                                                        |
| `POST /api/sync` returns `503`                   | `Retry-After` header; `github.rate_limit.*` events.                                                                       | Wait. Syncing backs off by itself and keeps stored content.                                                                                                                 |
| A run is stuck as `running`                      | `running` in `/api/status`.                                                                                               | A run whose process died holds no lock; after a one-minute grace period the next run marks it `failed`.                                                                     |
| Files are missing from a repository              | Warnings in the repository header and on `/status`: document cap, file too large.                                         | Raise `limits.maxDocsPerRepo` or lower the file size. The file size cap cannot exceed 256 KB.                                                                               |
| A word that is in a document finds nothing       | Search does not stem: `deploy` does not match `deployment`.                                                               | Search the exact form, or combine forms with `or`. See [Search](../guides/search.md).                                                                                       |

## Backups, upgrades and replicas

- **Backups.** Everything in the database is derived from GitHub, so a lost database is rebuilt by a full sync; only the sync history is lost. To keep it: `docker compose exec db pg_dump -U docmyrepos docmyrepos > backup.sql`.
- **Upgrade.** `git pull && docker compose up -d --build`. The new container applies pending migrations before it serves. Migrations are forward-only: to roll back, redeploy the previous image, and take a backup first if the new version added a migration.
- **Replicas.** Point them all at one database. Migrations are serialized by an advisory lock, only one replica runs each scheduled full sync, and syncs of one repository never overlap. Session-level advisory locks do not work through PgBouncer in transaction mode: connect directly, or through a pooler in session mode.
- **Stopping.** `docker stop` sends `SIGTERM`. The scheduler stops, a running sync is aborted, and the process exits with status 143, which Docker treats as a normal stop.
