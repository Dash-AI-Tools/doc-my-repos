# DocMyRepos

Search and showcase the Markdown documentation of all your GitHub repositories in one place.

DocMyRepos syncs the `docs/` folder of each repo you choose from your GitHub organization, then gives every repo its own space and gives the whole org one search box. It works with plain Markdown and has first-class support for [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

> **Status: planning.** The design is written and validated as an OpenSpec change (see [Project status](#project-status)). No application code exists yet, so the quickstart and commands below describe the intended behavior and will change as the code lands.

## Features

- **Per-repo space**: the main README, the code owners from `CODEOWNERS`, and a table of contents of the docs folder.
- **Good-looking Markdown**: GitHub-flavored Markdown, syntax highlighting, and [Mermaid](https://mermaid.js.org) diagrams.
- **Search**: full-text search across every synced repo, with highlighted snippets and a `⌘K` palette.
- **OKF aware**: when a repo uses OKF, filter by concept `type` (plus tags and status), and see each document's metadata.
- **Light and dark themes**: light, dark, or follow the system, including code blocks and diagrams.
- **Fresh content**: GitHub webhooks re-sync a repo when its default branch changes.
- **Self-hostable**: one Next.js app plus Postgres, with Docker Compose.

## How it works

```mermaid
flowchart LR
  GH[GitHub org] -- push webhook --> API[Next.js app]
  App[GitHub App installation] --> Sync
  Cfg[docmyrepos.config.yml] --> Sync
  API --> Sync[Sync engine]
  Sync -- tree / blobs / CODEOWNERS --> GH
  Sync --> DB[(Postgres)]
  DB --> UI[Repo pages + search]
```

The app reads repos from the GitHub API, stores parsed documents in Postgres, and serves pages from the database. It never calls GitHub while you browse.

## Quickstart

Requires Docker with Compose. (Developing on the host also needs Node.js 22+ and pnpm.)

```bash
cp .env.example .env     # set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, SYNC_SECRET
docker compose up -d --build --wait    # app + Postgres; the app applies the database migrations on start
curl -X POST -H "Authorization: Bearer <SYNC_SECRET from .env>" http://127.0.0.1:3000/api/sync   # first sync
```

Then open <http://127.0.0.1:3000>. Everything is optional beyond the `.env` values; to narrow the repositories, copy `docmyrepos.config.example.yml` to `docmyrepos.config.yml` and set `DOCMYREPOS_CONFIG=./docmyrepos.config.yml` in `.env` (see [Self-hosting with Docker](#self-hosting-with-docker)). Without the GitHub values the app still starts, and the home page and the logs name what is missing. You need a GitHub App first: follow the [GitHub App setup guide](docs/github-app-setup.md).

### Configuration

`docmyrepos.config.yml`:

Everything is optional. With no config, DocMyRepos shows every repository the GitHub App installation can access.

```yaml
repos: # optional: only these repos (must be accessible to the App)
  - name: api-service
  - name: web-app
    docsPath: documentation # override the default docs folder
exclude: [sandbox] # optional: skip these repos
defaults:
  docsPaths: [docs, doc, documentation] # first match wins, case-insensitive
limits:
  maxDocsPerRepo: 2000 # more docs: only the first 2000 in path order are synced
  maxFileBytes: 262144 # larger files are skipped; 256 KB is also the maximum
sync:
  intervalMinutes: 60 # full sync period, the fallback for missed webhooks; 0 = off, else >= 5
  onStartup: true # one full sync about 10 s after the server starts
```

Files left out by these limits are listed as a warning in the repository header and on `/status`.

The background scheduler runs the startup and periodic full syncs (with ±10 % jitter, retrying failed runs sooner with backoff up to 15 minutes) and, every minute, any per-repository syncs left waiting by busy repositories or a restart. It runs when `NODE_ENV=production` and is off in development and tests, so `pnpm dev` never calls GitHub on its own; `SYNC_SCHEDULER=1` or `SYNC_SCHEDULER=0` forces it on or off. With several instances only one runs a scheduled full sync at a time. Changes to `sync` apply after a restart.

### Sync status

`/status` shows the last sync run and every repository's sync state, errors and warnings. The same data is served as JSON at `GET /api/status` (no authentication, never cached, no secrets; it shows what the portal pages show). Use it for health checks: `200` means the app and its database answer, `503 {"error":"unavailable"}` means they do not. A failed repository sync does not change the status code; read `summary.error` or `lastRun.status` for that.

| Environment variable         | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`               | Postgres connection string                                                |
| `GITHUB_APP_ID`              | ID of your GitHub App                                                     |
| `GITHUB_APP_PRIVATE_KEY`     | App private key (PEM). Or set `GITHUB_APP_PRIVATE_KEY_PATH` to a key file |
| `GITHUB_APP_INSTALLATION_ID` | ID of the App's installation on your organization                         |
| `GITHUB_WEBHOOK_SECRET`      | Webhook secret (16+ characters) of the GitHub App, verifies signatures    |
| `SYNC_SECRET`                | Secret (16+ characters) that protects the manual `/api/sync` endpoint     |
| `LOG_LEVEL`                  | Optional: `debug`, `info` (default), `warn`, `error` or `silent`          |
| `SYNC_SCHEDULER`             | Optional: `1` or `0` forces the background sync scheduler on or off       |

### GitHub App

DocMyRepos authenticates as a GitHub App, not with a personal access token:

1. Register a GitHub App on your organization with **read-only** permissions for _Contents_ and _Metadata_.
2. Set its webhook URL to `https://<your-host>/api/webhooks/github`, choose a webhook secret, and subscribe to the `push`, `repository`, `installation_repositories` and `installation` events.
3. Generate a private key and install the App on your organization, on all repositories or a selection.
4. Copy the App id, the private key and the installation id into your environment.

The App's single webhook keeps content fresh and tells DocMyRepos when repositories are added to or removed from the installation. For local development, use a tunnel such as `smee.io` or `ngrok`. See the [GitHub App setup guide](docs/github-app-setup.md) for the steps and an [App manifest](docs/github-app-manifest.json).

## Self-hosting with Docker

The `Dockerfile` builds a small production image (multi-stage, Node 24 on Alpine, about 330 MB, runs as the non-root `node` user, uid 1000) and `docker-compose.yml` runs it with Postgres 17. Both hold no secrets: settings come from the environment, the optional config file is mounted.

```bash
docker build -t docmyrepos .
docker run -d --init --name docmyrepos -p 127.0.0.1:3000:3000 --env-file .env \
  -e DATABASE_URL=postgres://user:password@db.example.com:5432/docmyrepos \
  -v "$PWD/docmyrepos.config.yml:/app/docmyrepos.config.yml:ro" docmyrepos
```

### Environment

[`.env.example`](.env.example) lists every variable with its comment; copy it to `.env`. Compose passes `.env` to the app (the file may be missing, then the app reports what is not set).

| Variable                                                                                                          | Purpose                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                    | Required. Compose sets it for the app to the `db` service; set `APP_DATABASE_URL` to use another database |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`                                                                     | Required. From the GitHub App                                                                             |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`                                                         | Required, one of them. Inline PEM (one line in double quotes, `\n` for line breaks) or a key file path    |
| `GITHUB_WEBHOOK_SECRET`, `SYNC_SECRET`                                                                            | Required, 16+ characters each                                                                             |
| `CONFIG_PATH`                                                                                                     | Optional: config file path, default `docmyrepos.config.yml` in `/app`                                     |
| `LOG_LEVEL`, `SYNC_SCHEDULER`                                                                                     | Optional, see [Logging](#logging) and [Sync status](#sync-status). The scheduler is on in the image       |
| `SKIP_MIGRATIONS`, `DB_WAIT_SECONDS`                                                                              | Optional: skip the start-up migrations (`1`); how long to wait for the database (default `60`)            |
| `APP_BIND`, `APP_PORT`, `DOCMYREPOS_CONFIG`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Compose only: published address and port, config file to mount, database credentials                      |

Never set `E2E_FIXTURES`: it turns the server into a database-less fixture server for the browser tests.

### Config file and private key

- **Config:** compose mounts `./docker/docmyrepos.config.default.yml` (an empty config: every repository the App can access) read-only at `/app/docmyrepos.config.yml`. To use your own, set `DOCMYREPOS_CONFIG=./docmyrepos.config.yml` in `.env`. With `docker run` mount the file at that path, or mount it anywhere and set `CONFIG_PATH`. The file must exist before `docker compose up`: Docker would create a directory in its place. If no file exists in the container the defaults apply; an unreadable or invalid file is reported on the home page and in the logs.
- **Private key from a file:** instead of `GITHUB_APP_PRIVATE_KEY`, uncomment the `secrets` blocks in `docker-compose.yml` and set `GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github_app_key`. The container user (uid 1000) must be able to read the file, for example `chown 1000 github-app.private-key.pem && chmod 400 github-app.private-key.pem`. Keep the key out of the repository (`*.pem` is ignored).

### Start-up, migrations and health

The entrypoint (`docker-entrypoint.sh`) waits up to `DB_WAIT_SECONDS` (default 60) for the database, applies the SQL migrations in `/app/drizzle` (`dist/db-migrate.mjs`, a self-contained bundle: `pnpm build:migrate`), then starts the server. When the database stays unreachable or a migration fails, it prints a clear message (never the connection string) and the container exits with status 1. Migration runs take a Postgres advisory lock, so several containers may start together: one applies the migrations and the others wait, then find nothing to do. Migrations are forward-only; a restart does not apply them again.

- **Health:** the image has a `HEALTHCHECK` on `GET /api/status` (200: the app and its database answer; 503: they do not, or the configuration is invalid). `docker compose up --wait` waits for it. With the GitHub settings missing the home page loads with an error notice, `/api/status` answers 503 and the container becomes unhealthy after the 90 s start period.
- **Stopping:** `docker stop` sends `SIGTERM`; the scheduler stops, a running sync is aborted, and Next.js exits with status 143 (128 + SIGTERM), which Docker treats as a normal stop. `init: true` in compose (`--init` for `docker run`) reaps zombie processes.
- **Read-only:** compose runs the container with a read-only root file system and a `tmpfs` at `/tmp`, no capabilities and `no-new-privileges`.
- **Ports:** the app is published on `127.0.0.1:3000` and the database on `127.0.0.1:5432` (for development). In production remove the `db` ports entry, and change `APP_BIND` only if your reverse proxy runs on another host.

### Reverse proxy

Put a reverse proxy (nginx, Caddy, Traefik, a cloud load balancer) in front. It must:

- **Terminate TLS** and forward `X-Forwarded-Proto` by **overwriting** it with the scheme it received, never by appending to or trusting a client-supplied value. The app uses it to send HSTS only over HTTPS.
- **Not add security headers or a CSP.** The app sets its own (see [Security headers and CSP](#security-headers-and-csp)); a second copy may conflict.
- **Not cache HTML.** Pages are rendered per request with a nonce, and send `Cache-Control: no-store`. Only `/_next/static/*` is safe to cache.
- **Rate-limit** `/api/search`, `/api/sync` and `/api/status`. The app does not rate-limit; it only caps concurrent status reads.
- **Pass the webhook body untouched** to `/api/webhooks/github` (the signature covers the raw body) and allow bodies of the size GitHub sends (up to 25 MB).

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;   # overwrites any client value
  proxy_set_header X-Forwarded-For $remote_addr;
  client_max_body_size 25m;
}
```

The portal has no login: anyone who can reach it can read everything it has synced. Put authentication in front of it (network rules, an authenticating proxy) if any of the synced repositories are private. See the [Security note](#security-note).

### Operating

- **Logs** are JSON lines on stdout and stderr (`docker compose logs app`); keep `LOG_LEVEL` at `info` or above in production. Compose rotates them (3 files of 10 MB).
- **Upgrading:** `git pull && docker compose up -d --build`. The new container applies pending migrations before it serves. To roll back, redeploy the previous image; migrations are forward-only, so take a backup first if the new version added one.
- **Backups:** everything in the database is derived from GitHub, so a lost database is rebuilt by a full sync (the sync history is lost). To keep it: `docker compose exec db pg_dump -U docmyrepos docmyrepos > backup.sql`.
- **Several replicas:** point them all at one database. Migrations are serialized by the lock above (or set `SKIP_MIGRATIONS=1` on all but one, or migrate once with `docker compose run --rm --no-deps --entrypoint node app dist/db-migrate.mjs`). Only one replica runs each scheduled full sync, and repository syncs never overlap across replicas.
- **PgBouncer:** the sync locks and the migration lock are session-level advisory locks, which do not work through PgBouncer in transaction mode. Connect directly to Postgres, or through a pooler in session mode.

## Running e2e tests

```bash
pnpm exec playwright install chromium             # once
pnpm db:up                                        # Postgres for the e2e databases (same as docker compose --env-file .env.example up -d --wait db)
pnpm test:e2e
```

`pnpm test:e2e` builds the app once and starts four servers on ports 3100 to 3103: fixture pages without a database, a throwaway database seeded with public and private repositories (`e2e/support/seed-data.ts`), an empty one, and one whose database is unreachable. Each run creates `docmyrepos_e2e_<random>_seeded` and `_empty` databases on the server in `DATABASE_URL_E2E` (default: the compose database from `.env.example`) and drops them afterwards. The servers use a generated throwaway GitHub App key and placeholder secrets and run with the sync scheduler off (`SYNC_SCHEDULER=0`; the fixture server via `E2E_FIXTURES=1`); GitHub is never contacted.

Without a reachable Postgres the run fails at once and prints the command above. Set `E2E_SKIP_DB=1` to run only the specs that need no database; the others are skipped with a visible reason.

## Security note

The MVP is single-tenant and has no login. The GitHub App installation reads every repository you grant it, so **anyone who can reach the app can read everything it has synced**. Install the App only on repositories you want shown. If those include private repos, deploy privately or put authentication in front of the app. Private repos are marked with a badge, and the app records each repo's visibility, so per-user access through GitHub OAuth can be added later.

### Security headers and CSP

The app sets its own security headers (`src/proxy.ts`, values in `src/lib/security-headers.ts`); a reverse proxy does not need to add them.

- **Content-Security-Policy**, per request: `default-src 'none'`, scripts only with that request's nonce (`'strict-dynamic'`, no `'unsafe-inline'`, no `eval`), `img-src 'self' https:`, `connect-src 'self'`, no frames, no plugins, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`. Every page is rendered per request because of the nonce.
- **Styles allow `'unsafe-inline'`.** Shiki colours code with `style` attributes and Mermaid draws diagrams with their own `<style>` elements in the browser, where no nonce can be attached. Injected CSS cannot run script, but it could restyle or hide parts of a page. Markdown is sanitized, so documents cannot add `<style>` elements and `style` attributes are limited to code colours; Mermaid sanitizes the styling options a diagram may set.
- **External images load directly** from any `https:` host (badges, diagrams hosted elsewhere), without a referrer. That host then sees the reader's IP address. To forbid them, change `img-src` to `'self'`. Plain `http:` images are blocked.
- Also: `Referrer-Policy: same-origin` (portal URLs name private repositories), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a `Permissions-Policy` that denies camera, microphone, geolocation and other features except clipboard writes, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`. `X-Powered-By` is not sent. The image proxy `/api/asset` keeps its own stricter sandbox policy.
- **HTTPS:** terminate TLS at your reverse proxy and forward `X-Forwarded-Proto: https`. When a request arrives over HTTPS, a production build adds `Strict-Transport-Security: max-age=63072000; includeSubDomains` (no `preload`; add it at the proxy if you want your domain on the preload list) and `upgrade-insecure-requests`.
- **Loading from a CDN** (fonts, a script): add the origin to the one directive that needs it, for example `font-src 'self' https://fonts.example.com`, in `buildContentSecurityPolicy`. Never widen `default-src` or `script-src`.

### Logging

The server writes one JSON object per line: `debug` and `info` to stdout, `warn` and `error` to stderr, ready for `docker logs` or any log collector.

```json
{
  "ts": "2026-10-10T12:00:00.000Z",
  "level": "info",
  "service": "docmyrepos",
  "event": "sync.run.finished",
  "runId": 42,
  "trigger": "webhook",
  "scopeKind": "repo",
  "status": "success",
  "durationMs": 812,
  "repos": 1,
  "docsAdded": 2
}
```

- **Events** are stable dotted names: `sync.run.started`/`finished`, `sync.repo.done`/`removed`, `sync.discovery.done`/`failed`, `sync.request.done`/`coalesced`, `sync.drain.done`, `github.token.minted`/`mint_failed`, `github.installation.unavailable`, `github.rate_limit.wait`/`exceeded`, `webhook.received`/`signature`/`decision`/`task.finished`, `sync_api.auth`/`done`/`failed`, `asset.upstream_failed`, and the page loaders' `*.load_failed`. Unchanged repositories, tree short-circuits, retries and served images are `debug` only; nothing is logged per file.
- **`LOG_LEVEL`** sets the threshold (`debug`, `info`, `warn`, `error`, `silent`; default `info`). An unknown value stops the app at startup with a configuration error naming `LOG_LEVEL`.
- **Never logged:** the App private key, installation tokens, App JWTs, the webhook and sync secrets, the database password, request headers or bodies, webhook payload content and error messages or stacks (only an error's name, kind, SQLSTATE or OS code and HTTP status). Webhook lines carry GitHub ids, never repository names, which a sender controls. As a safety net, the logger also redacts values under credential-like keys (`token`, `secret`, `password`, `authorization`, `cookie`, `private key`, `jwt`, `signature`, ...), scrubs PEM blocks, `Bearer` credentials, GitHub token shapes, JWTs and `user:password@` URLs from any text, and strips control characters so a value cannot forge a log line.

## Project status

The work is specified with [OpenSpec](https://github.com/Fission-AI/OpenSpec) in `openspec/`:

- Active change: [`openspec/changes/docmyrepos-mvp/`](openspec/changes/docmyrepos-mvp/) with the proposal, nine capability specs, design, and the task list.
- Implementation follows `tasks.md` in order.

## Contributing

Contributions are welcome once the scaffold lands. Please open an issue to discuss larger changes first. A full `CONTRIBUTING.md` is part of the planned tasks.

## License

MIT (planned, to be confirmed with the `LICENSE` file).
