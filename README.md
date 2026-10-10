# DocMyRepos

[![CI](https://github.com/Dash-AI-Tools/doc-my-repos/actions/workflows/ci.yml/badge.svg)](https://github.com/Dash-AI-Tools/doc-my-repos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Search and showcase the Markdown documentation of all your GitHub repositories in one place.

DocMyRepos syncs the `docs/` folder of each repository you choose from your GitHub organization into Postgres, gives every repository its own space, and gives the whole organization one search box. It works with plain Markdown and has first-class support for [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/home-dark.png">
  <img alt="The DocMyRepos home page: a search box and a grid of repository cards" src="docs-assets/screenshots/home-light.png">
</picture>

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Self-hosting](#self-hosting)
- [Operations](#operations)
- [Security](#security)
- [Development](#development)
- [Project status and roadmap](#project-status-and-roadmap)
- [Contributing, conduct and license](#contributing-conduct-and-license)

## Features

- **Per-repository space**: the main README, the code owners from `CODEOWNERS`, and a tree of the docs folder.
- **Good-looking Markdown**: GitHub-flavored Markdown, syntax highlighting with Shiki, and [Mermaid](https://mermaid.js.org) diagrams. Documents are untrusted: output is sanitized and `.mdx` is never executed.
- **Search**: full-text search across every synced repository (Postgres full-text search, weighted by title, headings, description and body), with highlighted snippets, facets and a `Ctrl/Cmd+K` palette.
- **OKF aware**: when a repository uses OKF, filter by concept `type` (plus tags and status) and see each document's metadata, notices and change log. Other repositories show no OKF interface.
- **Light and dark themes**: light, dark, or follow the system, including code blocks and diagrams, without a flash on load.
- **Fresh content**: GitHub webhooks re-sync a repository when its default branch changes, and a scheduled full sync catches missed deliveries. Syncs are incremental (tree SHA, then blob SHA), idempotent and serialized per repository; a failed sync keeps the previous content.
- **Self-hostable**: one Next.js app plus Postgres, with a Docker image and Compose file. No login in the MVP (see [Security](#security)).

## Screenshots

Each image has a light and a dark version; GitHub shows the one that matches your theme. They are generated from seeded demo data by `pnpm screenshots`.

**A repository: README, documentation tree and code owners**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/repo-dark.png">
  <img alt="A repository page with its README, the documentation tree and the code owners panel" src="docs-assets/screenshots/repo-light.png">
</picture>

**A document with highlighted code and a Mermaid diagram**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/doc-dark.png">
  <img alt="A document page with code blocks, a table, a task list and a Mermaid diagram, next to an outline and the documentation tree" src="docs-assets/screenshots/doc-light.png">
</picture>

**Search across all repositories**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/search-dark.png">
  <img alt="Search results for the word deployment with highlighted snippets and repository, type and tag filters" src="docs-assets/screenshots/search-light.png">
</picture>

**The command palette (`Ctrl/Cmd+K`)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/palette-dark.png">
  <img alt="The quick search palette listing documents that match deployment" src="docs-assets/screenshots/palette-light.png">
</picture>

**OKF: filter by type, tag and status**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/okf-filters-dark.png">
  <img alt="An OKF repository with the Runbook and concept types selected in the filter panel" src="docs-assets/screenshots/okf-filters-light.png">
</picture>

**OKF: the metadata of a document**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs-assets/screenshots/okf-metadata-dark.png">
  <img alt="A document page with its OKF metadata card: type, status, tags, sources, dates and other fields" src="docs-assets/screenshots/okf-metadata-light.png">
</picture>

## How it works

```mermaid
flowchart LR
  GH[GitHub org] -- push webhook --> API[Next.js app]
  App[GitHub App installation] --> Sync
  Cfg[docmyrepos.config.yml] --> Sync
  API --> Sync[Sync engine]
  Sched[Scheduler] --> Sync
  Sync -- tree / blobs / CODEOWNERS --> GH
  Sync --> DB[(Postgres)]
  DB --> UI[Repo pages + search]
```

The app authenticates as a **GitHub App installation** (read-only, never a personal access token), discovers the repositories the installation can access, narrows them by `docmyrepos.config.yml`, and stores parsed documents (Markdown body, frontmatter, headings, title, type, tags, status) in Postgres. Pages and search read Postgres only: **GitHub is never called while you browse**, except the image proxy `/api/asset`, which fetches repository images on demand. HTML is rendered at read time and sanitized after all transforms.

| Route                                  | What it serves                                                            |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `/`                                    | Repository grid and search box                                            |
| `/<owner>/<repo>`, `.../docs/<path>`   | Repository space and documents                                            |
| `/search`, `GET /api/search`           | Search page and JSON search for the palette                               |
| `/status`, `GET /api/status`           | Sync status page and JSON (also the health check)                         |
| `POST /api/webhooks/github`            | GitHub App webhook, verified against the raw body with the webhook secret |
| `POST /api/sync`                       | Manual sync, guarded by `SYNC_SECRET` (`Authorization: Bearer <secret>`)  |
| `GET /api/asset/<owner>/<repo>/<path>` | Image proxy for documents; images only, path must be inside a synced repo |

## Quickstart

You need a **GitHub App** first. Register and install it by following the [GitHub App setup guide](docs/github-app-setup.md) (read-only _Contents_ and _Metadata_, four events, a webhook URL and secret). You end with the App id, a private key and the installation id. There is also an [App manifest](docs/github-app-manifest.json).

### With Docker (recommended)

Requires Docker with Compose.

```bash
git clone https://github.com/Dash-AI-Tools/doc-my-repos.git
cd doc-my-repos
cp .env.example .env
# edit .env: set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
# (or GITHUB_APP_PRIVATE_KEY_PATH), GITHUB_WEBHOOK_SECRET and SYNC_SECRET
docker compose up -d --build --wait    # app + Postgres 17; the app applies the migrations on start
```

Open <http://127.0.0.1:3000>. The first full sync starts about 10 seconds after the server does (the scheduler is on in the image). To start one yourself:

```bash
curl -X POST -H "Authorization: Bearer <SYNC_SECRET from .env>" http://127.0.0.1:3000/api/sync
```

The GitHub values in `.env.example` are blank on purpose and **must be real**. With them blank the server still starts, but `/api/status` answers `503` and `docker compose up --wait` fails because the container never becomes healthy. The home page then only says that the repositories could not be loaded; the container log names the missing variables (`docker compose logs app`, event `sync.scheduler.config_invalid`). To narrow the repositories, see [Configuration](#configuration).

### On your machine (development)

Requires Node.js 24, [pnpm](https://pnpm.io) 11.25 (`corepack enable && corepack prepare pnpm@11.25.0 --activate`) and Docker (for Postgres).

```bash
git clone https://github.com/Dash-AI-Tools/doc-my-repos.git
cd doc-my-repos
pnpm install
cp .env.example .env     # set the GitHub values to sync; DATABASE_URL already matches `pnpm db:up`
pnpm db:up               # Postgres 17 on 127.0.0.1:5432 (docker compose, db service only)
pnpm db:migrate          # applies the SQL migrations in drizzle/
pnpm dev                 # http://localhost:3000
```

The background scheduler is off in development, so `pnpm dev` never calls GitHub on its own. Start a sync with the `curl` command above (against `http://localhost:3000`). GitHub can only deliver webhooks to a public URL; use a tunnel such as smee.io or ngrok (see the [setup guide](docs/github-app-setup.md#8-local-development)). Without the GitHub values the app still starts, but the home page says the repositories could not be loaded and `/api/status` answers `503`. The dev server does not run the scheduler, so it does not log which variables are missing; compare your `.env` with the table below, or run a production build (`pnpm build && pnpm start`), whose log names them.

## Configuration

Behavior is configured by an optional file and by environment variables. **Secrets come only from the environment**, never from the file.

### `docmyrepos.config.yml`

Copy [`docmyrepos.config.example.yml`](docmyrepos.config.example.yml) and edit it. The file only **narrows** what the GitHub App installation can access; it never grants access. With no file, every repository the installation can access is synced and shown. The file is validated at startup; a mistake is reported on the home page and in the logs with the path of the offending field.

```yaml
repos: # optional: only these repos (bare names, must be accessible to the App)
  - api-service
  - name: web-app
    docsPath: user-guide # override the docs folder of this repo
exclude: [sandbox] # alternative to `repos`: everything except these (not both)
defaults:
  docsPaths: [docs, doc, documentation] # first match wins, case-insensitive
limits:
  maxDocsPerRepo: 2000
  maxFileBytes: 262144
sync:
  intervalMinutes: 60
  onStartup: true
```

| Key                     | Default                        | Meaning                                                                                                                                 |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`                 | all accessible repos           | Only these repositories. Entries are a name or `{ name, docsPath }`. No owner prefix, no duplicates. Cannot be combined with `exclude`. |
| `exclude`               | none                           | Skip these repositories.                                                                                                                |
| `defaults.docsPaths`    | `docs`, `doc`, `documentation` | Docs folder candidates, tried in order, matched case-insensitively. Relative paths without `..`.                                        |
| `limits.maxDocsPerRepo` | `2000` (1 to 10000)            | More documents: only the first N in path order are synced and a warning is shown.                                                       |
| `limits.maxFileBytes`   | `262144` (1024 to 262144)      | Larger files are skipped with a warning. 256 KB is also the maximum.                                                                    |
| `sync.intervalMinutes`  | `60`                           | Period of the full sync that catches missed webhooks. `0` turns it off, otherwise `5` to `10080`.                                       |
| `sync.onStartup`        | `true`                         | One full sync about 10 seconds after the server starts.                                                                                 |

Files left out by the limits are listed as a warning in the repository header and on `/status`. Changes to `sync` apply after a restart. The file path defaults to `docmyrepos.config.yml` in the working directory; set `CONFIG_PATH` to use another.

### Environment variables

[`.env.example`](.env.example) lists every variable with its comment. Real values go in `.env` (git-ignored) or the environment of your platform.

| Variable                                                                | Required | Purpose                                                                                                                           |
| ----------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                          | yes      | Postgres connection string (`postgres://` or `postgresql://`). Compose points the app at its `db` service itself.                 |
| `GITHUB_APP_ID`                                                         | yes      | Numeric ID of your GitHub App.                                                                                                    |
| `GITHUB_APP_INSTALLATION_ID`                                            | yes      | ID of the App's installation on your organization.                                                                                |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`               | one      | The App private key: PEM text (in `.env`: one line in double quotes with `\n` for line breaks) or a path to the file. Never both. |
| `GITHUB_WEBHOOK_SECRET`                                                 | yes      | Webhook secret of the App, 16+ characters. Verifies webhook signatures.                                                           |
| `SYNC_SECRET`                                                           | yes      | Secret protecting `POST /api/sync`, 16+ characters.                                                                               |
| `CONFIG_PATH`                                                           | no       | Config file path. Default `docmyrepos.config.yml`.                                                                                |
| `LOG_LEVEL`                                                             | no       | `debug`, `info` (default), `warn`, `error` or `silent`. An unknown value stops startup.                                           |
| `SYNC_SCHEDULER`                                                        | no       | `1` or `0` forces the background sync scheduler on or off. Default: on when `NODE_ENV=production`, off otherwise.                 |
| `SKIP_MIGRATIONS`, `DB_WAIT_SECONDS`                                    | no       | Container only: skip the start-up migrations (`1`); how long to wait for the database (default `60`).                             |
| `APP_BIND`, `APP_PORT`, `APP_DATABASE_URL`, `DOCMYREPOS_CONFIG`         | no       | Compose only: published address and port, an external database, the config file to mount.                                         |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`    | no       | Compose only: credentials and port of the `db` service.                                                                           |
| `TEST_DATABASE_URL`, `SKIP_DB_TESTS`, `DATABASE_URL_E2E`, `E2E_SKIP_DB` | no       | Tests only, see [Development](#development).                                                                                      |

Never set `E2E_FIXTURES`: it turns the server into a database-less fixture server for the browser tests.

## Self-hosting

The [`Dockerfile`](Dockerfile) builds a small production image (multi-stage, Node 24 on Alpine, runs as the non-root `node` user) and [`docker-compose.yml`](docker-compose.yml) runs it with Postgres 17. The image holds no secrets and no config: settings come from the environment and the optional config file is mounted. For a bare image:

```bash
docker build -t docmyrepos .
docker run -d --init --name docmyrepos -p 127.0.0.1:3000:3000 --env-file .env \
  -e DATABASE_URL=postgres://user:password@db.example.com:5432/docmyrepos \
  -v "$PWD/docmyrepos.config.yml:/app/docmyrepos.config.yml:ro" docmyrepos
```

- **Config file:** compose mounts `docker/docmyrepos.config.default.yml` (empty: every repository the App can access) at `/app/docmyrepos.config.yml`. To use your own, set `DOCMYREPOS_CONFIG=./docmyrepos.config.yml` in `.env`. The file must exist before `docker compose up`, otherwise Docker creates a directory in its place.
- **Private key from a file:** instead of `GITHUB_APP_PRIVATE_KEY`, uncomment the `secrets` blocks in `docker-compose.yml` and set `GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github_app_key`. The container user (uid 1000) must be able to read the file: `chown 1000 github-app.private-key.pem && chmod 400 github-app.private-key.pem`. Keep the key out of the repository (`*.pem` is ignored).
- **Start-up:** the entrypoint waits up to `DB_WAIT_SECONDS` for the database, applies the migrations in `/app/drizzle` under a Postgres advisory lock (several containers may start together; one migrates, the others wait), then starts the server. If the database stays unreachable or a migration fails, the container prints why (never the connection string) and exits with status 1. Migrations are forward-only.
- **Health:** the image has a `HEALTHCHECK` on `GET /api/status` (200: the app and its database answer; 503: they do not, or the configuration is invalid), with a 90 second start period.
- **Stopping:** `docker stop` sends `SIGTERM`. The scheduler stops, a running sync is aborted, and Next.js exits with status 143 (128 + SIGTERM), which Docker treats as a normal stop. Run with `--init` (compose has `init: true`).
- **Hardening in compose:** read-only root file system with a `tmpfs` at `/tmp`, all capabilities dropped, `no-new-privileges`, a process limit, rotated logs (3 files of 10 MB). The app is published on `127.0.0.1:3000` and the database on `127.0.0.1:5432` for development; **in production remove the `db` ports entry**, and change `APP_BIND` only if your reverse proxy runs on another host.
- **External database:** set `APP_DATABASE_URL` (percent-encode special characters in the password) and remove the `db` service and the `depends_on` in `docker-compose.yml`. Connect directly to Postgres or through a pooler in **session** mode: the sync and migration locks are session-level advisory locks, which do not work through PgBouncer in transaction mode.

### Reverse proxy

Put a reverse proxy (nginx, Caddy, Traefik, a cloud load balancer) in front. It must:

- **Terminate TLS** and forward `X-Forwarded-Proto` by **overwriting** it with the scheme it received, never by appending to or trusting a client-supplied value. The app uses it to send HSTS only over HTTPS.
- **Not add security headers or a CSP.** The app sets its own; a second copy may conflict.
- **Not cache HTML.** Pages are rendered per request with a nonce and send `Cache-Control: no-store`. Only `/_next/static/*` is safe to cache.
- **Rate-limit** `/api/search`, `/api/sync` and `/api/status`. The app does not rate-limit; it only caps concurrent reads.
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

**The portal has no login.** Anyone who can reach it can read everything it has synced. If any synced repository is private, put authentication in front of it (network rules, an authenticating proxy).

## Operations

- **Health and sync status:** `/status` shows the last sync run and every repository's state, errors and warnings. `GET /api/status` serves the same data as JSON (no authentication, never cached, no secrets; it shows what the pages show). `200` means the app and its database answer; `503 {"error":"unavailable"}` means they do not. A failed repository sync does not change the status code: read `summary.error` or `lastRun.status`.
- **Scheduler:** it runs the startup and periodic full syncs (with ±10 % jitter, retrying failures sooner with backoff up to 15 minutes) and, every minute, any per-repository syncs left waiting by busy repositories or a restart. With several instances only one runs a scheduled full sync at a time. `SYNC_SCHEDULER=0` turns it off.
- **Logs:** one JSON object per line, `debug` and `info` on stdout, `warn` and `error` on stderr (`docker compose logs app`). Event names are stable dotted names such as `sync.run.finished`, `webhook.received` and `sync.discovery.failed`. Keep `LOG_LEVEL` at `info` or above in production. Credentials, request bodies, error messages and stacks are never logged, and the logger redacts anything that looks like a secret.
- **Backups:** everything in the database is derived from GitHub, so a lost database is rebuilt by a full sync (the sync history is lost). To keep it: `docker compose exec db pg_dump -U docmyrepos docmyrepos > backup.sql`.
- **Upgrading:** `git pull && docker compose up -d --build`. The new container applies pending migrations before it serves. To roll back, redeploy the previous image; migrations are forward-only, so take a backup first.
- **Several replicas:** point them all at one database. Migrations are serialized by the advisory lock (or set `SKIP_MIGRATIONS=1` on all but one, or migrate once with `docker compose run --rm --no-deps --entrypoint node app dist/db-migrate.mjs`). Repository syncs never overlap across replicas.
- **Rotating secrets:** see the [setup guide](docs/github-app-setup.md#rotating).

## Security

Docs come from third-party repositories and are treated as untrusted. See [SECURITY.md](SECURITY.md) to report a vulnerability.

- **Read-only GitHub App.** Contents and Metadata, read-only. Installation tokens are short-lived, cached and refreshed. The private key, tokens and secrets never reach the browser, the logs or error messages.
- **No login (MVP).** The portal is single-tenant: anyone who can reach it can read everything the App installation can read and the config selects. Install the App only on repositories you want shown, and put authentication in front of the app if some are private. Private repositories are marked with a badge, and the app records each repository's visibility so per-user access can be added later.
- **Sanitized rendering.** HTML is sanitized after every rehype transform; `.mdx` is never executed; Mermaid runs with `securityLevel: 'strict'`.
- **Verified inputs.** Webhook signatures are checked against the raw body; `/api/sync` needs `SYNC_SECRET`; `/api/asset` only serves image content types from inside a configured repository and blocks path traversal.
- **Security headers and CSP** are set by the app (`src/proxy.ts`, values in `src/lib/security-headers.ts`) and need no help from the proxy:
  - `Content-Security-Policy` per request: `default-src 'none'`; scripts only with that request's nonce (`'strict-dynamic'`, no `'unsafe-inline'`, no `eval`); `img-src 'self' https:`; `connect-src 'self'`; no frames, plugins, `base-uri` or foreign form targets; `frame-ancestors 'none'`.
  - **Styles allow `'unsafe-inline'`.** Shiki colours code with `style` attributes and Mermaid draws diagrams with their own `<style>` elements in the browser, where no nonce can be attached. Injected CSS cannot run script, but it could restyle a page. Markdown is sanitized, so documents cannot add `<style>` elements, and `style` attributes are limited to code colours.
  - **External images load directly** from any `https:` host, without a referrer; that host then sees the reader's IP address. To forbid them, change `img-src` to `'self'` in `buildContentSecurityPolicy`. Plain `http:` images are blocked.
  - Also `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`. `X-Powered-By` is not sent.
  - **HTTPS:** behind a TLS proxy that forwards `X-Forwarded-Proto: https`, a production build also sends `Strict-Transport-Security: max-age=63072000; includeSubDomains` (no `preload`) and `upgrade-insecure-requests`.
  - **Loading from a CDN** (fonts, a script): add the origin to the one directive that needs it in `buildContentSecurityPolicy`. Never widen `default-src` or `script-src`.

## Development

Requires Node.js 24, pnpm 11.25 and Docker. After `pnpm install` and `cp .env.example .env`:

```bash
pnpm db:up               # Postgres 17 for development and tests (docker compose, db service only)
pnpm db:migrate          # apply migrations
pnpm dev                 # run the app
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint
pnpm format:check        # prettier (pnpm format writes)
pnpm test                # unit and database tests (Vitest)
pnpm test:e2e            # browser tests (Playwright), needs Postgres
pnpm build               # production build
pnpm db:generate         # create a Drizzle migration after a schema change
pnpm screenshots         # regenerate docs-assets/screenshots
openspec validate docmyrepos-mvp
```

**Unit and database tests.** `pnpm test` runs Vitest over `src/**` and `tests/unit/**`. Pure logic (CODEOWNERS, frontmatter, link rewriting, the config schema) is unit-tested; sync, queries and search run against a **real Postgres** and fail loudly when none is reachable: start it with `pnpm db:up`. The database tests create and drop a throwaway database on the server in `TEST_DATABASE_URL` (default: `DATABASE_URL`, then the compose database). Set `SKIP_DB_TESTS=1` to skip them (a warning says so).

**End-to-end tests.** One-time setup: `pnpm exec playwright install chromium` (add `--with-deps` on a fresh Linux machine). Then, with Postgres up (`pnpm db:up`), `pnpm test:e2e` builds the app once and starts four servers on ports 3100 to 3103: fixture pages without a database, a throwaway database seeded with public and private repositories (`e2e/support/seed-data.ts`), an empty one, and one whose database is unreachable. Each run creates `docmyrepos_e2e_<random>_seeded` and `_empty` databases on the server in `DATABASE_URL_E2E` (default: the compose database) and drops them afterwards. The servers use a generated throwaway GitHub App key and placeholder secrets, and GitHub is never contacted. Without a reachable Postgres the run fails at once and prints the command above; `E2E_SKIP_DB=1` runs only the specs that need no database. The suite includes axe accessibility checks in both themes.

**CI** (`.github/workflows/ci.yml`) runs lint, format check, type check, unit tests, the production build, the e2e tests with a Postgres 17 service, a Docker image build on linux/amd64 with a smoke test, and `openspec validate`, on every pull request and on pushes to `main`. It uses no secrets, so it also runs for pull requests from forks. Actions are pinned to commit SHAs and kept current by Dependabot.

**Layout.** `src/server/` holds everything that touches GitHub, Postgres or the filesystem and has no React; `src/components/` has no database access; `src/app/` is routing. Every read of repos, documents, search, facets and assets goes through the one visibility filter in `src/server/queries/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions and the pull request checklist.

## Project status and roadmap

The MVP is specified with [OpenSpec](https://github.com/Fission-AI/OpenSpec) in [`openspec/changes/docmyrepos-mvp/`](openspec/changes/docmyrepos-mvp/) (proposal, nine capability specs, design and the task list), and the application is implemented. What is still open before a first release:

- The [GitHub App setup guide](docs/github-app-setup.md) has not been walked through end to end on a real organization yet (its last section lists what to confirm).
- CI has been validated locally but its first run on a pull request is pending, and the Docker image is only verified on arm64 locally (CI builds amd64).

Out of scope for the MVP, and candidates for later: GitHub OAuth login and per-user access to private repositories, an in-app repository picker, multi-tenancy, and editing documents in the UI.

## Contributing, conduct and license

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md), and open an issue to discuss larger changes first. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

DocMyRepos is released under the [MIT License](LICENSE).
