---
type: Guide
title: Install wizard
description: Install DocMyRepos with one command, npx create-docmyrepos. What it checks and asks, how it creates or checks the read-only GitHub App, the files it writes, how it starts and verifies the stack, the options for scripted and dry-run installs, and how to read its source before running it.
tags: [guides, install, docker, github-app]
status: stable
sources:
  - packages/create-docmyrepos/src/args.ts
  - packages/create-docmyrepos/src/run.ts
  - packages/create-docmyrepos/src/plan.ts
  - packages/create-docmyrepos/src/compose-template.ts
  - packages/create-docmyrepos/README.md
  - docker-compose.yml
generated: 2026-10-15
verified: 2026-10-15
stale_after: 2999-01-01
---

# Install wizard

`npx create-docmyrepos` sets up a complete DocMyRepos in a new folder: it checks your machine, creates (or checks) the read-only GitHub App, generates every secret, writes the Docker Compose files, starts the stack and starts the first sync. It is the quickest path to a running portal. The other paths, [cloning the repository](./getting-started.md) and [registering the App by hand](../github-app-setup.md), stay supported.

## What you need

- Node.js 20 or newer (only to run the installer).
- Docker with Compose v2 (Docker Desktop, or Docker Engine with the Compose plugin), running.
- A GitHub organization where you may register and install a GitHub App, or an existing App for it.

## Run it

```bash
npx create-docmyrepos            # installs into ./docmyrepos
npx create-docmyrepos my-docs    # or into another folder
```

`npm create docmyrepos` and `pnpm create docmyrepos` do the same. The installer checks Docker, Compose, the folder and the port before it asks anything that takes effort, and stops with how to fix the problem when one fails. Nothing is written until you have seen the list of files and confirmed.

## What it asks

Every question has a default or a flag, and a flag answers it without a prompt.

| Question                           | Flag            | Default                                                   |
| ---------------------------------- | --------------- | --------------------------------------------------------- |
| GitHub organization                | `--org`         | none                                                      |
| Address the portal is reached at   | `--url`         | `http://localhost:3000`; a public address needs `https`   |
| Host port (published on 127.0.0.1) | `--port`        | `3000`, or the port in a loopback address                 |
| First admin's email                | `--admin-email` | none                                                      |
| First admin's password             | environment     | asked twice, hidden; the wizard can generate a strong one |
| Which repositories                 | `--repos`       | all the App can access, or a picked list in the terminal  |
| GitHub App                         | `--app`         | `create` in a terminal; `existing` for scripted installs  |

The session secret, the sync secret and the database password are generated with a cryptographically secure source (256 bits each) and are never asked for.

## The GitHub App

- **Create** (`--app create`, needs a terminal). The wizard opens GitHub in your browser with a read-only App (_Contents_ and _Metadata_ read, events `push` and `repository`) filled in, receives the result on a temporary page bound to `127.0.0.1`, and keeps the App id, private key and webhook secret itself. It then opens the install page, waits for you to install the App on the organization, and finds the installation id by asking GitHub. With `--no-browser` it prints the addresses instead and asks you to paste the code from the browser's address bar.
- **Existing** (`--app existing`). You give the App id, the path of its `.pem` key and its webhook secret. The wizard checks them against GitHub, shows the App's name and warns if the App has any permission other than read-only _Contents_ and _Metadata_.

The webhook is turned on only for a public `https` address. For `localhost` the portal relies on its scheduled sync until you have a public address; see [Webhooks](./webhooks.md).

## What it writes

Into the folder, never over an existing installation (a folder with an `.env` or a `docker-compose.yml` is refused unless you pass `--force`, which first moves them to timestamped backups):

| File                         | Mode   | Holds                                                                            |
| ---------------------------- | ------ | -------------------------------------------------------------------------------- |
| `docker-compose.yml`         | `0644` | The app and Postgres 17, hardened like the repository's file, image pinned       |
| `.env`                       | `0600` | Every required setting and the generated secrets, plus the bootstrap admin       |
| `docmyrepos.config.yml`      | `0644` | The repository choice (empty means all); see [Configuration](./configuration.md) |
| `.gitignore`                 | `0644` | Keeps `.env`, keys and backups out of git                                        |
| `github-app.private-key.pem` | `0600` | The App key, only in the file layout below                                       |

The compose file pins the image `ghcr.io/dash-ai-tools/doc-my-repos` at the installer's own version, so installer 1.2.0 installs image 1.2.0. `--image-tag` overrides it for testing. The database port is not published.

**Where the key lives.** The container runs as user id 1000. When your user id is 1000, or Docker Desktop maps ownership (macOS, Windows), the key is a file mounted as a compose secret. Otherwise a file you own would be unreadable inside the container, so the key goes inline into the owner-only `.env`, which the wizard tells you. Inline means the key is visible in `docker inspect` to root-equivalent users.

## Start and verify

Unless you pass `--no-start`, the wizard runs `docker compose pull`, then `docker compose up -d --wait`, which returns when the health check passes, and then asks the app to start the first sync (the sync secret goes in a request header, never in an argument). A failure at any step is reported with its name, the last log lines and the command to read more, the files are kept, and the exit code is non-zero.

Open the address, sign in with the admin email and password and follow the sync at `/status`. The scheduler also starts a sync shortly after boot and hourly, so a sync that could not be started from the wizard begins by itself.

**Remove the bootstrap credentials.** The admin email and password stay in `.env` until you delete the `ADMIN_EMAIL` and `ADMIN_PASSWORD` lines. The wizard offers to do this after you confirm you have signed in; if you decline it prints the two lines and the restart command (`docker compose up -d`).

**Upgrading.** Set `DOCMYREPOS_VERSION` in `.env` to the new version, then run `docker compose pull` and `docker compose up -d --wait`. Take a backup first (see the [operations runbook](../reference/operations.md)); migrations are forward-only.

## Scripted installs

With `--yes` nothing is asked: every answer comes from flags and environment variables, and when input is not a terminal a missing answer is listed with all the others and the wizard exits with code 2. Secrets are never flags, so they stay out of shell history and process lists.

```bash
DOCMYREPOS_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
DOCMYREPOS_APP_ID=123456 DOCMYREPOS_APP_KEY_FILE=./app-key.pem \
DOCMYREPOS_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  npx create-docmyrepos --yes --org acme --admin-email admin@acme.io --app existing --repos all
```

### Options

| Option                   | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `[folder]`, `--dir`      | Folder to install into (default `./docmyrepos`)                    |
| `--org`                  | GitHub organization                                                |
| `--url`                  | Address the portal is reached at                                   |
| `--port`                 | Host port, published on 127.0.0.1 only                             |
| `--admin-email`          | First admin's email                                                |
| `--repos all\|a,b,c`     | All repositories the App can access, or bare names                 |
| `--app existing\|create` | Use an existing App, or create one in the browser                  |
| `--image-tag`            | Image tag to pin (default: the installer's version)                |
| `-y`, `--yes`            | Never prompt; accept confirmations                                 |
| `--dry-run`              | Run the checks and print the plan; write, create and start nothing |
| `--no-start`             | Write the files; do not pull or start                              |
| `--force`                | Back up an existing installation's files and replace them          |
| `--no-browser`           | Do not launch a browser; paste the App's code by hand              |
| `-h`, `--help`           | Show the help                                                      |
| `-v`, `--version`        | Print the installer's version                                      |

### Environment variables

| Variable                     | Meaning                                 |
| ---------------------------- | --------------------------------------- |
| `DOCMYREPOS_ADMIN_PASSWORD`  | First admin's password (12+ characters) |
| `DOCMYREPOS_APP_ID`          | Existing App: the App id                |
| `DOCMYREPOS_APP_KEY_FILE`    | Existing App: path of the `.pem` key    |
| `DOCMYREPOS_INSTALLATION_ID` | Existing App: the installation id       |
| `DOCMYREPOS_WEBHOOK_SECRET`  | Existing App: the webhook secret        |
| `DOCMYREPOS_GITHUB_API_URL`  | Testing only: a fake GitHub on loopback |

### Exit codes

`0` success, `1` failure (files already written are kept), `2` usage error or missing answers, `130` interrupted. An interrupt leaves no half-written `.env` or key file.

## Dry run

`--dry-run` runs the checks and the questions, prints every file it would write and every command it would run with the secrets hidden, and then stops. Nothing is written, no App is created and nothing is started.

```bash
npx create-docmyrepos --dry-run --org acme --admin-email admin@acme.io
```

## Read it before you run it

The installer has no dependencies and uses only Node.js built-ins. Its only network traffic goes to GitHub and, through Docker, to the container registry; there is no telemetry. To read exactly what npm serves before running it:

```bash
npm view create-docmyrepos                 # version, repository, maintainers, file count
npm pack create-docmyrepos --pack-destination /tmp
tar -xzf /tmp/create-docmyrepos-*.tgz -C /tmp && ls /tmp/package/dist
```

The package holds the compiled files in `dist/`, the `bin` entry, the README and the license, and nothing else. The source is in `packages/create-docmyrepos/` of the repository.

## Troubleshooting

- **Docker is not running, or Compose is missing.** The wizard names the failed check and how to fix it, and writes nothing.
- **The port is taken.** In a terminal the wizard offers another; with `--yes` it stops. Pass `--port`.
- **The folder already holds an installation.** Choose another folder, or pass `--force` to back the old files up and replace them.
- **The stack does not become healthy.** The wizard prints the last log lines. Read more with `docker compose logs app` from the folder. The log names a missing or invalid setting; see [Configuration](./configuration.md).
