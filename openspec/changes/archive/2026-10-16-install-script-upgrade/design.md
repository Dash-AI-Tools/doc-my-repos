# Design

## Context

See `proposal.md` for the motivation and `specs/install-script/spec.md` for behavior. `install.sh` already holds the checks, the prompt helpers, `valid_*` validators and the start/health code; an installation is a folder with `docker-compose.yml` and `.env`. The compose file takes the app image from `DOCMYREPOS_IMAGE` in `.env`, the database user and name are fixed (`docmyrepos`), and the project name is in `.env` as `COMPOSE_PROJECT_NAME`. Migrations are forward-only, so a downgrade needs a restored database, not just an older image.

## Goals / Non-Goals

**Goals:** one command to upgrade; a backup that always exists before the app changes; a failure before the restart harms nothing; a clear way back.

**Non-Goals:** automatic rollback (restoring over a database an operator may have changed is their decision), rewriting the compose file, looking up new versions on the network, backing up anything but the database, pruning old backups.

## Decisions

**1. A mode of the same script, `--upgrade`.** The version in the script is the target, so "upgrade" is "run the new release's script", which keeps the installer and image versions matched with no lookup of a latest version and no new network call. A separate `upgrade.sh` would be a second file to trust and to keep in step. The mode reuses the checks, validators, prompts, health check and failure output; it skips the port, admin and secret steps.

**2. Order: read, compare, plan, pull, back up, change `.env`, restart, verify.** Everything that can fail cheaply comes first. The image is pulled with `DOCMYREPOS_IMAGE=<new> docker compose pull` (the shell value wins over `.env` in Compose), so a failed download leaves `.env` and the running app as they were. The backup comes next, then the one-line `.env` change, then `up -d --wait`.

**3. Backup is a plain SQL dump through the running database container.** `docker compose exec -T db pg_dump --clean --if-exists -U docmyrepos docmyrepos > backup-<UTC stamp>.sql` under `umask 077`, in the install folder. `--clean --if-exists` makes the restore one command (`psql < file`). The file must be non-empty or the upgrade stops and removes it. If the database container is not running the upgrade stops before any change, with the command to start it.

**4. Only the image line changes.** `.env` is rewritten line by line (`IFS= read -r`, `printf '%s\n'`, never `eval` or `sed` with user text) into a temporary file with owner-only permissions, then moved over the original, replacing only the `DOCMYREPOS_IMAGE=` line. Values such as a password with `$` or spaces survive untouched. The compose file is left alone: it may have been edited by the operator (a proxy network, a memory limit), and the hardening it carries is unchanged between releases; a release that needs a compose change says so in its notes.

**5. Version comparison only when it is certain.** When the installed and target references name the same image and both tags are `MAJOR.MINOR.PATCH`, the numbers are compared field by field and an older target is refused. In every other case (a different image, a digest, a local tag such as `ci`) no comparison is made and the change proceeds, because the script cannot know the order. Equal references are "already up to date" and exit 0 before any pull or backup.

**6. Failure after the restart prints recovery and stops.** The script does not roll back by itself: migrations may already have run, and restoring a database is a decision for the operator. It prints the log tail, the backup path and two commands: stop the app and `psql < backup`, then set `DOCMYREPOS_IMAGE` to the previous value and `up -d`.

**7. No terminal means proceed.** Like the installer, a run with `--yes` or without a terminal does not ask. The plan is always printed first, and `--dry-run` stops after it.

## Risks / Trade-offs

- [A dump taken while the app writes is not a snapshot of a single instant] → `pg_dump` is transactionally consistent for the database; documents are rebuilt by a sync, and the next write is not part of the backup by design.
- [Large databases make the dump slow or big] → The backup is written next to the data; the guide tells operators to move or delete old `backup-*.sql` files, which are never pruned automatically. Sizes here are small (documents derived from GitHub, users, settings, comments).
- [A backup file holds password hashes and encrypted secrets] → Owner-only permissions like `.env`; the guide says to treat it like `.env`.
- [Edited compose files keep old hardening if a release changes it] → Left to release notes, stated in the guide; a later change can add a compose diff warning.
- [Downgrade refused only for known versions] → Other cases proceed because order is unknowable; the guide documents the restore path for a deliberate rollback.
