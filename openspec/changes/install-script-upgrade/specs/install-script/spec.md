# Spec Delta

## ADDED Requirements

### Requirement: Upgrade an installation in place
The installer SHALL provide an upgrade mode that moves an installation it created to the image of the installer's own version, or to an image given explicitly. It SHALL change only the image in the environment file, keep the compose file, every other value and the stored data, and wait until the new version's health check passes. It SHALL stop and change nothing when the folder holds no installation it can upgrade.

#### Scenario: Upgrade to the installer's version
- **WHEN** an operator runs the newer installer in upgrade mode on an installation of an older version
- **THEN** the installation runs the newer image, its health check passes, and its data and every other setting are unchanged

#### Scenario: Not an installation
- **WHEN** the folder has no environment file, no compose file, or no image setting
- **THEN** the installer stops, says why, and changes nothing

### Requirement: Back up before upgrading
Before it changes anything on disk or restarts anything, the upgrade SHALL save a backup of the database to a file in the installation folder readable by its owner only, and SHALL stop without changes when the backup cannot be made or is empty.

#### Scenario: Backup is taken
- **WHEN** an upgrade proceeds
- **THEN** a non-empty backup file with owner-only permissions exists in the installation folder before the environment file is changed

#### Scenario: Backup fails
- **WHEN** the backup cannot be made, for example because the database is not running
- **THEN** the upgrade stops, no partial backup is left, and the environment file and the running containers are unchanged

### Requirement: A failed upgrade does not harm the running installation
The upgrade SHALL obtain the new image before it touches the environment file, so that a failed download leaves the installation exactly as it was. If the new version does not become healthy after the restart, the upgrade SHALL name the failing step, print the end of the app log, and print the backup file and the commands to restore it and return to the previous image. It SHALL NOT change the installation again by itself.

#### Scenario: Image cannot be obtained
- **WHEN** the new image cannot be pulled
- **THEN** the upgrade stops before the backup is used or the environment file changes, and says that nothing was changed

#### Scenario: New version is unhealthy
- **WHEN** the restarted app does not become healthy
- **THEN** the upgrade exits with an error and prints the log tail, the backup path, and the commands to restore the backup and set the previous image

### Requirement: No pointless or unsafe version change
The upgrade SHALL report an installation that already runs the target image as up to date, exit successfully and change nothing. When the installed and the target image are versions (`MAJOR.MINOR.PATCH` tags) of the same image and the target is older, the upgrade SHALL refuse, because database migrations only go forward, and SHALL change nothing.

#### Scenario: Already current
- **WHEN** the installation already runs the target image
- **THEN** the installer says it is up to date, exits with success, and takes no backup and restarts nothing

#### Scenario: Older target
- **WHEN** the target version is older than the installed version of the same image
- **THEN** the installer refuses, explains that migrations are forward-only, and changes nothing

### Requirement: Upgrade can be previewed and scripted
The upgrade SHALL accept the folder and the image as flags or `DOCMYREPOS_*` variables, SHALL run without questions when `--yes` is given or no terminal is available, SHALL ask for confirmation in a terminal after showing what will change, and SHALL show the installed and target image and the backup it would make and change nothing when `--dry-run` is given.

#### Scenario: Dry run
- **WHEN** the installer runs in upgrade mode with `--dry-run`
- **THEN** it prints the installed and target image and the planned backup, and writes, pulls and restarts nothing

#### Scenario: Declined
- **WHEN** the operator answers no at the confirmation
- **THEN** nothing is changed
