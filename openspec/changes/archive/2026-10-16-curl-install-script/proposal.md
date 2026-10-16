# Proposal

## Why

Installing DocMyRepos today means cloning the repository, copying `.env.example`, generating three secrets by hand, and building the Docker image locally. Each step is a place to stop. Since GitHub App credentials, repositories and Ask now live in the database and are entered in the admin pages, what an installer must do is small and mechanical: generate the secrets, write the files, start the stack. That fits one `curl ... | sh` command that asks a few questions in the terminal.

This replaces the earlier `npx create-docmyrepos` plan (the `install-wizard` change, now removed). That plan needed a Node package, an npm release, and a GitHub App manifest flow with a local callback server, and it wrote `GITHUB_APP_*` variables and `docmyrepos.config.yml`, which the app no longer reads.

## What Changes

- **An installer script, `install.sh`, run as `curl -fsSL <url>/install.sh | sh`.** POSIX `sh`, no dependency beyond `curl`, `openssl` (or `/dev/urandom`) and Docker. It asks, with defaults, in the terminal:
  - **Checks first:** a supported OS (Linux, macOS, WSL), Docker and Docker Compose v2 present, the Docker daemon running, the chosen port free. A missing prerequisite stops the script with how to fix it, before anything is written.
  - **Asks:** the install folder (default `./docmyrepos`), the port (default `3000`), the first admin's email, and the admin password (typed hidden, or generated and shown once).
  - **Generates every secret** (`SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET`, `SYNC_SECRET`, the database password) with a cryptographically secure source, never the placeholders from `.env.example`.
  - **Writes the installation:** `docker-compose.yml` and `.env` (owner-only), never overwriting an existing installation.
  - **Starts it:** pulls the published image, starts the app and Postgres, waits for the health check, and prints the address, the admin sign-in, and the next steps (sign in, open **Admin > Workspace configuration**, enter the GitHub App, **Run first sync**).
- **Prompts work through a pipe.** Because `curl | sh` uses stdin for the script, questions are read from the terminal (`/dev/tty`). With no terminal, the script runs only if every answer is given by flag or environment variable, and otherwise lists what is missing and exits.
- **Non-interactive and dry-run modes:** `--yes` with flags and `DOCMYREPOS_*` variables, and `--dry-run`, which prints the plan and writes nothing.
- **A published container image.** The installer needs something to pull, so a release workflow builds and pushes a versioned multi-architecture image to GitHub Container Registry on a version tag. The script pins the image version matching its own release.
- **The GitHub App is not created by the script.** Setup stays in the app (and the existing setup guide), where it is already validated and stored encrypted. The script points there.
- **Nothing is sent anywhere** except the download of the script, the image pull and the loopback health check. No telemetry, no account.
- Not changed: how the app runs, its configuration, the manual clone-and-compose path (still documented), and the GitHub App permissions (read-only). Not included: TLS or reverse proxy setup, Kubernetes or Helm, upgrading, uninstalling, native Windows shells, and creating the GitHub App from the terminal.

## Capabilities

### New Capabilities

- `install-script`: the installer's prerequisite checks, questions, validation, generated secrets, written files, start-up and verification, non-interactive and dry-run modes, and its safety rules.
- `container-image-release`: the published, versioned container image, how it is built and tagged from a release tag, and the guarantee that an installer release installs the matching image.

### Modified Capabilities

- `deployment-and-oss`: the "One-command local and container run" requirement now includes the installer path, and its scenario no longer says GitHub App credentials are set in the environment file (they are entered in the app).

## Impact

- New `install.sh` at the repository root, with tests in `tests/unit/` that run it under `sh` against stubbed `docker` and `openssl`, and ShellCheck in CI.
- New workflow `.github/workflows/release.yml`: on a `v*.*.*` tag, builds and pushes `ghcr.io/dash-ai-tools/doc-my-repos` for `linux/amd64` and `linux/arm64` with provenance, minimum token permissions, and a repository guard so forks do not publish. `Dockerfile` gains OCI labels added at build time.
- CI gains a job that runs the installer non-interactively against the image built in the run, checks `/api/health`, the login page and a rejected overwrite, then tears it down.
- Docs: `README.md` quickstart leads with the one-liner (and keeps the clone-and-compose path); a new `docs/guides/install-script.md` with OKF frontmatter; `docs/github-app-setup.md` links back to it. No app runtime code, database or API changes.
- Removed: `openspec/changes/install-wizard/` (the npx plan), which was unimplemented (0 of 23 tasks) and is recoverable from git history.
- Needs a human once: the first release tag, to publish the image, and making the GHCR package public.

## Assumptions

- The image is published at `ghcr.io/dash-ai-tools/doc-my-repos`, next to the source repository.
- The script is fetched from the repository's raw URL at a release tag (or `main` for the latest). A short vanity domain is out of scope.
- The installer uses Docker Compose, like the recommended path today; there is no "run from source" mode.
