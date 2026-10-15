# Proposal

## Why

Installing DocMyRepos today means cloning the repository, copying `.env.example`, registering a GitHub App by hand (a long guide), finding three credentials, generating three secrets, and building the Docker image locally. Each step is a place to stop. An organization that wants to try the portal should be able to run one command and answer a few questions.

## What Changes

- **An installer you run with `npx create-docmyrepos`** (also `npm create docmyrepos`, `pnpm create docmyrepos`). It is an interactive wizard that asks only what it cannot work out, then sets up and starts a complete installation in a new folder:
  - **Checks first:** Node version, Docker and Docker Compose present and running, the chosen port free. A missing prerequisite stops the wizard with how to fix it, before anything is written.
  - **Asks:** the GitHub organization, the address the portal will be reached at (default `http://localhost:3000`), the first admin's email and password (or generates the password), which repositories to include (all the App can see, or a picked list), and the port.
  - **Sets up the GitHub App for you.** The wizard registers a read-only GitHub App through GitHub's *app manifest* flow: it opens the browser to GitHub with the manifest filled in, receives the result on a temporary local page, and keeps the App id, private key and webhook secret itself. It then opens the install page, waits for the install, and finds the installation id by asking GitHub. Anyone who already has an App can enter its values instead, and the wizard checks them against GitHub.
  - **Generates every secret** (session, sync, database password) with a cryptographically secure generator. It never uses the placeholders from `.env.example`.
  - **Writes the installation:** `docker-compose.yml`, `.env`, `docmyrepos.config.yml` and the App private key, owner-only permissions, never overwriting an existing installation.
  - **Starts it:** pulls the published image, starts the app and Postgres, waits for the health check, starts the first sync, and prints the address, the admin sign-in and the next steps.
- **Non-interactive mode** for scripts and automation (`--yes` with flags and environment variables), and `--dry-run` that shows the plan and writes nothing.
- **Published artifacts.** The installer needs something to install, so releases now publish a **versioned container image** to GitHub Container Registry and the **installer package** to npm, both from CI on a version tag, with provenance. The generated compose file pins the image version that matches the installer.
- **Nothing is sent anywhere except GitHub.** No telemetry, no account, no calls to the project's servers.
- Not changed: how the app runs, its configuration, the manual install path in the README (still supported and documented), and the GitHub App's permissions (read-only contents and metadata). Not included: TLS or reverse proxy setup, a hosted/cloud install, Kubernetes or Helm, upgrading an existing installation (`docker compose pull` stays the upgrade path), uninstalling, and Windows-native shells without Docker Desktop.

## Capabilities

### New Capabilities

- `install-wizard`: the installer's prerequisite checks, questions, validation, generated secrets, written files, start-up and verification, non-interactive and dry-run modes, and its safety rules.
- `github-app-provisioning`: how the installer creates a read-only GitHub App with the manifest flow, accepts an existing App, discovers the installation, and lists repositories to choose from.
- `release-artifacts`: the published container image and installer package, how they are built and versioned, and the guarantee that an installer release installs the matching image.

### Modified Capabilities

- None. Packaging and the GitHub App guide live in the `docmyrepos-mvp` change spec (`deployment-and-oss`), which is not yet archived into `openspec/specs/`. These capabilities add a new install path and do not rewrite those requirements.

## Impact

- New package `packages/create-docmyrepos/` (TypeScript, built to plain JavaScript, no runtime dependencies, Node 20 or newer), with its own tests. It is added to the pnpm workspace (`pnpm-workspace.yaml`) and to lint, format and CI; it does not import app code.
- New CI workflow `.github/workflows/release.yml`: on a `v*` tag, builds and pushes the multi-architecture image to `ghcr.io` and publishes the npm package, both with provenance attestations, using OIDC and the minimum token permissions. Existing CI gains a job that tests the installer, including an end-to-end install against the built image.
- `Dockerfile` gains OCI labels (source, version, license). `docs/github-app-manifest.json` becomes the single manifest the installer uses (extended with the fields the wizard needs), and `docs/github-app-setup.md` documents the automated path next to the manual ones.
- No change to app runtime code, the database or the API. The installed `docker-compose.yml` is generated from a template that is checked against the repository's `docker-compose.yml` for the hardening settings.
- Tests: unit tests for prompts, validation, generators and file writing; tests with a fake GitHub server for the manifest flow and installation discovery; an end-to-end install in CI with Docker; a package-contents test (`npm pack`).
- Docs: `README.md` quickstart leads with the wizard, with the clone-and-compose path kept; a new `docs/guides/` page for the installer, with OKF frontmatter.
- Needs a human once: the manifest flow has never been run against real GitHub (the existing guide says so). A spike task does it on a throwaway organization before the rest is built.

## Assumptions

- The package name is `create-docmyrepos` (it was free on npm when this was planned; a task confirms and reserves it).
- The image is published at `ghcr.io/dash-ai-tools/doc-my-repos`, next to the source repository.
- The wizard installs with Docker Compose, the same as the recommended path today. A "run from source" mode is not offered.
