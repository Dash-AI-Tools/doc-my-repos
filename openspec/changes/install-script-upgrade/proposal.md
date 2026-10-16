# Proposal

## Why

`install.sh` installs DocMyRepos but cannot upgrade it: running it again is refused, so upgrading means editing `.env` and typing Compose commands by hand, with no backup and nothing stopping a downgrade that the forward-only migrations cannot undo. Operators who installed with one command should be able to upgrade with one command.

## What Changes

- **`install.sh --upgrade`** upgrades an installation made by the script, in place: `sh install.sh --upgrade --dir <folder>`, or `curl -fsSL <url>/install.sh | sh -s -- --upgrade --dir <folder>`. The target is the image of the script's own version (so running the newer release's script upgrades to it), or the image named by `--image`.
- **Safe order:** checks, a plan (and `--dry-run` stops here), confirmation in a terminal, then pull the new image, **back up the database to an owner-only file in the install folder**, change only the image line of `.env`, restart, wait for the health check. A failure before the restart leaves the running installation untouched.
- **No surprises:** an installation already on the target version is reported up to date and left alone. A target older than the installed version (when both are known versions of the same image) is refused, because migrations are forward-only. The compose file and every other `.env` value are left as they are.
- **Recovery is printed:** if the new version does not become healthy, the script prints the end of the app log, the backup file and the exact commands to restore it and go back.
- Not changed: a fresh install, its questions and files. Not included: automatic rollback, rewriting the compose file, scheduling or notifying about new versions, backups of anything but the database.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `install-script`: adds the requirements for upgrading an existing installation in place, the backup and ordering guarantees, the refusal to downgrade, and the printed recovery steps.

## Impact

- `install.sh` (a new `--upgrade` mode and help text), `tests/unit/install-script.test.ts` (stubbed upgrade cases), `scripts/install-e2e.sh` (a real upgrade in CI against the image it built).
- Docs: the "Upgrade, stop and remove" section of `docs/guides/install-script.md`, a line in the README quickstart, and the docs change log.
- No change to the app, its image, the database or the release workflow.

## Assumptions

- Upgrades run the new release's script; the script does not look up "the latest version" on the network (it only ever contacts the registry for the pull).
- A plain-SQL dump (`pg_dump`) taken through the running database container is a sufficient backup for the sizes this product stores (documents derived from GitHub, users, settings, comments).
