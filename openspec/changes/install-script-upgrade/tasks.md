# Tasks

## 1. Upgrade mode

- [x] 1.1 Add `--upgrade` to `install.sh`: argument and help text, reading `DOCMYREPOS_IMAGE` and `APP_PORT` from the folder's `.env` without evaluating them, the "not an installation" stop, the up-to-date exit, the version comparison that refuses an older target only for the same image with `MAJOR.MINOR.PATCH` tags, the plan, `--dry-run`, and the confirmation; verify unit tests with stubbed Docker for each of those paths (nothing changes in any refusal, dry run or decline)
- [x] 1.2 Add the pull-first, back-up, image-line-only rewrite, restart and health sequence with the recovery output (log tail, backup path, restore and go-back commands) and owner-only backup and `.env`; verify unit tests for the order (pull, then dump, then restart), a failed pull (nothing changed, no backup), a failed or empty backup (no partial file, `.env` unchanged), the database not running, a failed restart (new image kept, recovery printed), every other `.env` line preserved byte for byte (including a password with `$` and spaces), the compose file untouched, and a local image not being pulled
- [x] 1.3 Keep ShellCheck clean and the existing install tests passing; verify `shellcheck -s sh -S style install.sh` and the whole `tests/unit/install-script.test.ts` pass

## 2. End-to-end and docs

- [x] 2.1 Extend `scripts/install-e2e.sh` to upgrade the installed stack to a second tag of the same image, then check health, the new image in `.env`, one owner-only non-empty backup containing the schema, that the administrator can still sign in, the compose file unchanged, and that a second `--upgrade` is a no-op without a new backup; verify by running it with real Docker, and that breaking the image rewrite on purpose makes it fail
- [x] 2.2 Document the upgrade in the "Upgrade, stop and remove" section of `docs/guides/install-script.md` (command, what it does and does not do, the backup file, restoring, the downgrade rule), add the one-line mention to the README quickstart and an entry to `docs/log.md`; verify the dogfood and unit tests pass and the documented flags match `install.sh --help`
- [x] 2.3 Run `openspec validate install-script-upgrade` and the full suite (`pnpm typecheck && pnpm lint && pnpm test`); verify all pass

## Workflow follow-up

- Archive the change after review, which syncs the added requirements into `openspec/specs/install-script/`.
