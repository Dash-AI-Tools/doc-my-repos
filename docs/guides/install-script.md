---
type: Guide
title: Install with the script
description: Install DocMyRepos with Docker by running one command and answering a few questions in the terminal. What the installer checks, asks, writes and starts, its flags and variables, how to read it first, and what to do next in the app.
tags: [guides, setup, docker]
status: stable
sources:
  - install.sh
  - scripts/install-e2e.sh
  - scripts/check-release-versions.sh
  - docker-compose.yml
generated: 2026-10-16
verified: 2026-10-16
stale_after: 2999-01-01
---

# Install with the script

`install.sh` sets up a complete DocMyRepos with Docker on your own machine: it checks that Docker works, asks four questions, generates every secret, writes a compose file and an `.env`, starts the app and its Postgres database, and waits until the app is healthy. It does **not** register your GitHub App: you enter that in the app after the first sign-in, where it is validated and stored encrypted.

The other way to install is the clone-and-compose path in [Getting started](./getting-started.md).

## Run it

You need Linux, macOS or WSL, `curl`, and Docker with Compose v2 running.

```bash
curl -fsSL https://github.com/Dash-AI-Tools/doc-my-repos/releases/download/v0.1.0/install.sh | sh
```

The URL is the `install.sh` asset on the GitHub Release for that tag. Replace `v0.1.0` with the release you want; the script installs the container image of its own version (`ghcr.io/dash-ai-tools/doc-my-repos:0.1.0`). To pass flags to a piped script, put them after `sh -s --`:

```bash
curl -fsSL https://github.com/Dash-AI-Tools/doc-my-repos/releases/download/v0.1.0/install.sh | sh -s -- --dry-run
```

**Read it first.** It is one file of about 700 lines. Fetch it, read it, then run it from disk:

```bash
curl -fsSLO https://github.com/Dash-AI-Tools/doc-my-repos/releases/download/v0.1.0/install.sh
less install.sh
sh install.sh
```

The script contacts only the container registry (to pull the image) and `http://127.0.0.1` (the health check). It sends no telemetry and fetches nothing else.

## What it asks

Each question shows its default in brackets. Press Enter to accept it.

| Question                  | Default        | Notes                                                                                  |
| ------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| Install folder            | `./docmyrepos` | Created if missing. It must not already hold a `.env` or `docker-compose.yml`.         |
| Port for the portal       | `3000`         | Asked again if the port is busy.                                                       |
| First administrator email | none           | Used to sign in the first time.                                                        |
| Administrator password    | generated      | Typed without echo, 12 or more characters, no `'` or `\`. Press Enter to generate one. |

It then shows a summary and asks for confirmation before it writes anything. A generated password is shown once, at the end, and is also in the `.env` file.

## What it writes and starts

Two files in the install folder, both readable only by you (the folder is `0700`, `.env` is `0600`):

- `docker-compose.yml`: the app and Postgres 17, with the same hardening as the repository's compose file (read-only root file system, no capabilities, no new privileges, a process limit, rotated logs). The app is published on `127.0.0.1` only, and the database is not published at all.
- `.env`: the generated secrets (`SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET`, `SYNC_SECRET`, the database password), the image, the port, and the first administrator.

Each install gets its own Compose project name (`docmyrepos-` and six random hex digits), so two installs never share a database volume.

Then it pulls the image (unless it is already on the machine), starts the containers, and waits for the health check. Files are written completely or not at all: if something fails before the files are in place, the ones it created are removed. It never overwrites an existing installation.

## After it finishes

1. Open the address it prints and sign in as the administrator.
2. Go to **Admin > Workspace configuration** and enter your GitHub App ([GitHub App setup](../github-app-setup.md) explains how to register one).
3. On the **Repository access** tab, press **Run first sync**.
4. Remove `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`, then run `docker compose up -d` in the install folder.

**Back up the `.env` file with your database.** `SETTINGS_ENCRYPTION_KEY` decrypts the secrets stored in the database; without it they cannot be read and must be entered again.

## Flags and variables

Every answer can be given up front. With `--yes`, or when there is no terminal, nothing is asked: a missing answer is listed and the script exits with status 2 before writing anything.

| Flag                  | Variable                    | Meaning                                                                     |
| --------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `--dir <folder>`      | `DOCMYREPOS_DIR`            | Install folder.                                                             |
| `--port <number>`     | `DOCMYREPOS_PORT`           | Port on this machine.                                                       |
| `--admin-email <e>`   | `DOCMYREPOS_ADMIN_EMAIL`    | First administrator's email.                                                |
| none                  | `DOCMYREPOS_ADMIN_PASSWORD` | Administrator password. Environment only, so it never reaches `ps`.         |
| `--image <reference>` | `DOCMYREPOS_IMAGE`          | Container image, for a mirror or a build of your own.                       |
| `--upgrade`           | none                        | Upgrade the installation in `--dir` to the image (see [Upgrade](#upgrade)). |
| `--yes`               | none                        | Never ask.                                                                  |
| `--dry-run`           | none                        | Show the checks, the plan and the files, and write and start nothing.       |
| `-h`, `--help`        | none                        | Show the options.                                                           |

An example for automation:

```bash
DOCMYREPOS_ADMIN_PASSWORD='a long password' \
  sh install.sh --yes --dir /opt/docmyrepos --port 8080 --admin-email you@example.com
```

Without a given password, `--yes` generates one and prints it once.

## Upgrade

Run the **newer release's** script with `--upgrade` and the folder of your installation. The script's own version is the target, so using the script of release `v0.2.0` upgrades to image `0.2.0`:

```bash
curl -fsSL https://github.com/Dash-AI-Tools/doc-my-repos/releases/download/v0.2.0/install.sh | sh -s -- --upgrade --dir ./docmyrepos
```

Add `--dry-run` to see what it would do, or `--image <reference>` to upgrade to a specific image (a mirror, a build of your own). In a terminal it shows the plan and asks before it starts; with `--yes`, or with no terminal, it does not ask.

What it does, in this order:

1. Checks that the folder holds an installation made by the script, and that the installation is not already on the target version (then it says so and stops, changing nothing).
2. Refuses a **downgrade**: when both versions are known (`MAJOR.MINOR.PATCH` tags of the same image) and the target is older, it stops, because database migrations only go forward.
3. Pulls the new image. If that fails, nothing has changed.
4. Saves a **backup of the database** to `backup-<UTC time>.sql` in the install folder, readable only by you. If the database is not running or the backup is empty or fails, it stops and nothing has changed.
5. Changes **only** the `DOCMYREPOS_IMAGE` line in `.env`. The compose file, every other setting and your data are kept.
6. Restarts and waits for the health check.

It never rolls back by itself, because the new version may already have migrated the database. If the new version does not become healthy, it prints the end of the app log, the backup file and the commands to go back:

```bash
cd ./docmyrepos
docker compose stop app
docker compose exec -T db psql -U docmyrepos -d docmyrepos < backup-<time>.sql
# in .env, set DOCMYREPOS_IMAGE back to the previous value
docker compose up -d --wait
```

The backup is a plain SQL dump that drops and recreates the tables when restored. It holds your users and stored settings, so treat it like `.env`. Old backups are never deleted for you: remove them when you are sure the new version works.

The compose file is not rewritten. If a release changes it, its notes say so; to compare, run a fresh install of the new release into another folder and diff the two `docker-compose.yml` files.

## Stop and remove

- **Stop:** `docker compose stop` in the install folder.
- **Remove everything, including the data:** `docker compose down -v` deletes the database volume. Keep a backup if the comments or users matter.

## If it stops

| Message                                 | What to do                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Docker is not installed / not reachable | Install Docker, or start it (Docker Desktop, or `sudo systemctl start docker`). |
| Docker Compose v2 is not installed      | Install the Compose plugin; the old `docker-compose` (v1) is not supported.     |
| Port is already in use                  | Choose another port with `--port`.                                              |
| Already contains an installation        | Choose another folder. The script never changes an existing one.                |
| Could not pull the image                | Check the network and the image name; a mirror goes in `--image`.               |
| Could not reach a healthy state         | Read the log it prints, or run `docker compose logs app` in the install folder. |

When start-up fails the files stay in place so you can read the logs and fix the cause.
