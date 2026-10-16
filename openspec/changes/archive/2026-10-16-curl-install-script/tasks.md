# Tasks

## 1. Script skeleton and prerequisite checks

- [x] 1.1 Create `install.sh` (POSIX `sh`, `set -eu`, all logic in a `main` function called on the last line, `DOCMYREPOS_VERSION` constant, `--help`, `--dry-run`, `--yes` and flag/`DOCMYREPOS_*` parsing with fixed messages); verify `sh -n install.sh` passes, `shellcheck install.sh` is clean, and a truncated copy of the file runs nothing and writes nothing
- [x] 1.2 Add the prerequisite checks (OS, `docker`, `docker compose` v2, daemon reachable, target folder state, port free with `lsof`/`ss`/`nc` fallbacks and a clear skip); add `tests/unit/install-script.test.ts` with a helper that runs the script under `sh` with a stubbed `PATH` (`docker`, `openssl`, `lsof`, `curl` recording their calls) and a temp working folder; verify tests for Docker missing, old `docker-compose`, daemon stopped, port busy and existing `.env` or compose file all stop with a named reason and create no file

## 2. Questions and validation

- [x] 2.1 Add the terminal prompts (read from `/dev/tty`, defaults shown, hidden password with an `stty` restore trap, summary and confirmation, re-ask on invalid input) and the non-terminal behavior (needs every answer from flags or the environment, lists all missing ones, exit 2); verify tests drive the prompts through a pseudo-terminal or a stubbed tty path, covering defaults, a declined confirmation, and the missing-answers listing
- [x] 2.2 Validate answers (port 1 to 65535, plausible email, folder path without control characters, password of at least 12 characters, password only from the environment when non-interactive) and never expand an answer as shell code; verify tests with hostile values (`$(touch x)`, backticks, `;`, newline, spaces in the folder) prove no embedded command runs and that rejected values are explained

## 3. Secrets and written files

- [x] 3.1 Generate `SETTINGS_ENCRYPTION_KEY` (32 bytes, base64), `SESSION_SECRET` and `SYNC_SECRET` (32 bytes, hex), the database password (24 bytes, hex) and an optional admin password, from `openssl rand` with a `/dev/urandom` fallback; verify tests for the formats the app accepts (checked against the rules in `src/server/config/env.ts`), that no placeholder value appears, that two runs differ, and that the secrets never appear in stdout or stderr
- [x] 3.2 Write `.env` and `docker-compose.yml` (folder `0700`, `.env` `0600`, temporary names then `mv`, rollback trap, never overwrite); embed the compose file as in design decision 7 with the image taken from `DOCMYREPOS_IMAGE` or the pinned version and no database port; verify tests for modes, atomicity (a failure between the two writes leaves no file), the exact `.env` variable set, and `--dry-run` writing nothing
- [x] 3.3 Add a parity test that parses the embedded compose file and the repository's `docker-compose.yml` and asserts the same hardening keys and values and no database `ports`; verify it fails when a hardening key is removed from either side

## 4. Start-up, verification and output

- [x] 4.1 Implement `docker compose pull`, `up -d --wait --wait-timeout 180`, the loopback `/api/health` check, the success summary (address, admin email, next steps with the exact admin pages, reminder to remove the two bootstrap lines, generated password shown once) and the failure output (failing step, `logs --tail 30 app`, the command for more); verify tests with stubbed `docker` and `curl` for success, a failed pull, and an unhealthy app, and that on failure the files are kept
- [x] 4.2 Add a network-safety test that scans `install.sh` for any `http://` URL other than the loopback address, any host other than the image registry, the raw-script URL and the printed documentation links, and any use of `eval`; verify it fails when one is added

## 5. Image release

- [x] 5.1 Add OCI label support to the build (labels passed at build time, none baked into the `Dockerfile` text) and a script `scripts/check-release-versions.sh` that fails unless the tag, `package.json` version and `DOCMYREPOS_VERSION` in `install.sh` are equal; verify with tests (a matching and a mismatching set) and by running the script locally
- [x] 5.2 Add `.github/workflows/release.yml` as in design decision 10 (tag trigger, repository guard, `permissions: {}` with per-job grants, verify job reusing `ci.yml`, multi-architecture build, push to GHCR with provenance, guard against an existing version, actions pinned to SHAs); verify with a workflow test like the existing CI workflow tests (guard, permissions, pinning, no long-lived secret) and `actionlint` if available

## 6. CI end-to-end install

- [x] 6.1 Add a CI job (after the image build) that runs `DOCMYREPOS_IMAGE=docmyrepos:ci sh install.sh --yes` with test answers into a temporary folder, waits for `/api/health` 200, fetches `/login`, runs the installer again to prove the refusal, and always runs `docker compose down -v`; add ShellCheck for `install.sh`; verify the job passes in a pull request and fails when the compose hardening or an env variable is broken on purpose in a scratch commit

## 7. Docs and cleanup

- [x] 7.1 Add `docs/guides/install-script.md` with OKF frontmatter (questions, flags and variables, files written, `sh -s -- --dry-run`, reading the script first, what to do next in the app, removing the bootstrap admin lines), and link it from `docs/index.md` and `docs/github-app-setup.md`; verify the repository's own docs still pass the OKF checks used by the sync tests and the documented command runs as written against the CI job's image
- [x] 7.2 Lead the README quickstart with the one-liner (tag-pinned URL, `main` for latest, the `sh -s --` form for flags) and keep the clone-and-compose section; verify `pnpm format:check` passes, the README and the guide agree on every flag and variable, and the commands in the README were run once end to end
- [x] 7.3 Run `openspec validate curl-install-script` and the full suite (`pnpm typecheck && pnpm lint && pnpm test`); verify all pass and that nothing references the removed `install-wizard` or `create-docmyrepos`

## Workflow follow-up

- Needs a human once: push the first `v*.*.*` tag after the version check passes, set the GHCR package visibility to public, and only then publish the README one-liner.
- Archive the change after review, which syncs `install-script`, `container-image-release` and the `deployment-and-oss` delta into `openspec/specs/`.
