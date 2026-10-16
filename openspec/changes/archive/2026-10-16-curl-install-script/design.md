# Design

## Context

See `proposal.md` for the motivation and the specs (`install-script`, `container-image-release`, `deployment-and-oss`) for behavior. Facts that shape the approach:

- **Startup needs only four secrets.** `DATABASE_URL` (compose builds it from `POSTGRES_*`), `SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET` and `SYNC_SECRET` come from the environment (CLAUDE.md: startup secrets only from env). Everything else, the GitHub App, repositories, limits and Ask, is entered at `/admin/workspace` and stored encrypted in the database. `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters) create the first admin on first login while no users exist.
- **The compose file builds locally.** `docker-compose.yml` has `build: .` and `image: docmyrepos:local`, and publishes the database port for development. No image is published, so an installer outside a checkout has nothing to pull.
- **The app is already hardened in compose** (read-only root, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, pids limit, log rotation, `init`, loopback port) and the image carries the health check.
- **The superseded `install-wizard` plan** assumed `GITHUB_APP_*` variables and `docmyrepos.config.yml`, which no longer exist, and a Node package with a manifest-flow callback server. Settings moving into the database removed the reason for most of it.
- CI already builds the image and smoke-tests it (`scripts/docker-smoke.sh`); actions are pinned to commit SHAs.

## Goals / Non-Goals

**Goals:**
- From nothing to a signed-in portal ready for GitHub App entry with one command and four answers.
- Safe for people who pipe a download to a shell: small, readable, no surprise network calls, no secrets in output or arguments, no overwriting.
- One file to trust, no dependency tree, testable without Docker.

**Non-Goals:**
- Creating the GitHub App from the terminal, or pushing settings into the app. The in-app page validates and encrypts them, and a second path would duplicate that.
- TLS, reverse proxy or DNS, upgrades, uninstall, backups, native Windows, installing from source.

## Decisions

**1. One POSIX `sh` file, `install.sh`, at the repository root.** `curl | sh` is the convention people expect and needs nothing installed. Alternatives: the Node `create-*` package (needs Node, an npm release and a dependency or two to audit, for no capability the script lacks); a `bash` script (not present on minimal Alpine or some CI images, and `sh` is enough); a hosted installer endpoint (a server to run and trust). The file is pinned by URL to a release tag in the docs (`.../v1.2.3/install.sh`), with `main` shown for the latest.

**2. The whole script is one `main` function, called on the last line.** A download cut off mid-stream then defines nothing complete and runs nothing; this is the standard guard for piped scripts. Everything runs under `set -eu` (no `-o pipefail`, which `sh` lacks), values are always quoted, and no answer is passed to `eval`, `sh -c` or an unquoted expansion.

**3. Prompts read from `/dev/tty`, not stdin.** With `curl | sh`, stdin is the script. A `prompt` helper does `read ... </dev/tty` (and `stty -echo` for the password, restored by a `trap` on exit, interrupt and error). If `/dev/tty` cannot be opened, the script is non-interactive: it needs every answer from flags or environment, and otherwise prints all missing names at once and exits 2. `--yes` forces non-interactive even with a terminal. Arguments reach a piped script as `curl ... | sh -s -- --dry-run`, which the docs show once.

**4. Checks run first and are cheap to read.** `uname` (Linux, Darwin; WSL is Linux), `docker --version`, `docker compose version` (v2; the old `docker-compose` binary is rejected with a pointer), `docker info` (daemon reachable), the folder (absent or empty, and no `.env` or `docker-compose.yml`), and the port. The port check tries, in order, `lsof -i`, `ss -ltn`, `nc -z` and, if none exists, skips with a note and lets Compose report a conflict. A busy port in a terminal re-asks; otherwise it exits.

**5. Secrets come from `openssl rand` with a `/dev/urandom` fallback.** `SETTINGS_ENCRYPTION_KEY` is 32 random bytes, base64 (what the app requires). `SESSION_SECRET` and `SYNC_SECRET` are 32 bytes in hex (64 characters, over the 16 minimum). The database password is 24 bytes in hex, so it never needs URL escaping in `DATABASE_URL`. Hex and base64 avoid shell and `.env` quoting problems. A generated admin password is 18 random bytes in base64url-safe characters, printed once at the end. Secrets are written with `umask 077` through a here-document into the file, never through `echo` with arguments, so they never appear in `ps` or terminal output.

**6. Files are written atomically and rolled back together.** The script creates the folder (`0700`), writes `.env` and `docker-compose.yml` to temporary names in it, and `mv`s both into place only after both are complete. A `trap` removes anything it created if a later step fails before start-up. After start-up, files are left in place on failure so the operator can read the logs. An existing `.env` or compose file is a hard stop, never an overwrite.

**7. The compose file is embedded in the script and checked against the repository's.** A second download would be a second thing to trust and to keep in step, so the file is a here-document in `install.sh`. It is the repository's file with `build:` replaced by `image: ${DOCMYREPOS_IMAGE:-ghcr.io/dash-ai-tools/doc-my-repos:<version>}`, the database `ports` entry removed, and the app's port taken from `APP_PORT` and `APP_BIND` in `.env`. A unit test parses both files and asserts the hardening keys are equal (`read_only`, `tmpfs`, `cap_drop`, `security_opt`, `pids_limit`, `logging`, `init`, healthcheck interval, the `depends_on` condition) and that the database has no `ports`, so a hardening change in the repository file cannot be missing from the installer. Alternative: generating the file from the repository's at release time (more build machinery for the same result; revisit if the file changes often).

**8. Start-up uses Compose's own waiting.** `docker compose pull` (skipped when `docker image inspect` finds the image already on the machine, which is how a locally built or mirrored image, and the CI image, are used), then `docker compose up -d --wait --wait-timeout 180`, which honors the image's health check. Success is `up` exiting 0 plus one `GET http://127.0.0.1:<port>/api/health` through `curl`. On failure the script prints the failing step, `docker compose logs --tail 30 app` (the app never logs secrets) and the command for more. The final summary gives the address, the admin email, and four steps with the exact pages: sign in, **Admin > Workspace configuration**, enter the GitHub App (link to `docs/github-app-setup.md`), **Run first sync**. It also reminds the operator to remove `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env` after the first sign-in, as the README already says; it does not edit `.env` again.

**9. Version pinning comes from the file itself.** `install.sh` holds `DOCMYREPOS_VERSION="x.y.z"`, stamped at release by the release workflow's version check (the file in `main` carries the next version, so the stamp is checked, not rewritten). The default image is `ghcr.io/dash-ai-tools/doc-my-repos:$DOCMYREPOS_VERSION`; `DOCMYREPOS_IMAGE` overrides it for testing and mirrors. This is the "installer and image versions match" guarantee.

**10. The release workflow is separate from CI and minimal.** `.github/workflows/release.yml`, trigger `push: tags: v*.*.*`, `if: github.repository == 'Dash-AI-Tools/doc-my-repos'`, top-level `permissions: {}` with per-job grants. Jobs: `verify` (checks tag equals `package.json` version equals the version in `install.sh`, then runs the existing CI set by reusing `ci.yml` through `workflow_call`), `image` (needs `verify`; Buildx and QEMU, build `linux/amd64,linux/arm64`, push to `ghcr.io/dash-ai-tools/doc-my-repos:<version>` and `latest` using `GITHUB_TOKEN` with `packages: write` only, `provenance: mode=max`, OCI labels from the tag; a guard step fails if the version tag already exists in the registry). The `release` environment can require a reviewer before `image` runs. Actions are pinned to SHAs, like `ci.yml`. No npm publish, no long-lived secret.

**11. Tests: shell stubs in Vitest, one Docker run in CI.** Unit tests (`tests/unit/install-script.test.ts`) run `sh install.sh` with a temporary `PATH` that holds fake `docker`, `openssl`, `lsof` and `curl` that record their calls, and a temporary working folder. They cover each requirement's scenarios: prerequisite failures leave no files; validation of port, email, path and a hostile value; permissions of `.env` (`0600`) and the folder (`0700`); secrets differ between runs and are absent from stdout; refusal to overwrite; rollback; `--dry-run` writes nothing; no-terminal failure lists missing answers; truncated script runs nothing; no `http://` URL and no host other than the registry appears in the script. ShellCheck runs on `install.sh` and the CI script in the existing CI. A new CI job runs `DOCMYREPOS_IMAGE=docmyrepos:ci sh install.sh --yes ...` after the image build, polls `/api/health`, fetches `/login`, runs the script again to prove the refusal, and always runs `docker compose down -v`. This is the only test that needs Docker, and it reuses the image CI already builds.

**12. Docs.** The README quickstart leads with the one-liner and `sh -s -- --dry-run`, and keeps the clone-and-compose section. A new `docs/guides/install-script.md` (OKF frontmatter, so the repository's own docs show it) lists the questions, flags and variables, the files written, and how to read the script before running it (`curl -fsSL <url> | less`).

## Risks / Trade-offs

- [Piping a download to a shell is a trust decision] → One short readable file, version-pinned URLs in the docs, a "read it first" line, no hidden downloads (the image pull is the only fetch), a full-script guard, and tests that fail if a plain-HTTP URL or a new host appears.
- [Embedded compose drifts from the repository's] → The parity test in decision 7 and CI running the installer on every change to the installer, `docker-compose.yml`, `Dockerfile` or `src/server/config/env.ts`.
- [The admin password sits in `.env` until removed] → Owner-only file, a generated password printed once, and a reminder with the exact lines to remove; the app already documents this.
- [A password typed in a terminal] → `stty -echo` with a restore trap, never echoed or passed as an argument; non-interactive mode reads it only from the environment.
- [Port detection differs by OS] → Several tools tried in order, a clear skip when none exists, and Compose still reports a real conflict.
- [`curl | sh` on a corporate or offline host] → The script runs saved, too (`curl -O`, review, `sh install.sh`), and `DOCMYREPOS_IMAGE` accepts a mirror.
- [First release needs a human] → Pushing the first tag and setting the GHCR package public are manual, listed in the tasks. Until then the installer's default image does not exist, so the docs link the installer only after that release.

## Migration Plan

New files only; nothing existing changes behavior. Merge, push the first tag after the version check passes, make the package public, then publish the README link. Rollback: delete the tag's image and revert the README section; installs already made keep working because they pin their own image version. Existing clone-and-compose installs are unaffected.
