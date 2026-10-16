# install-script Specification

## Purpose

Lets an operator install a working DocMyRepos with Docker on their own machine by running one command and answering a few questions in the terminal, without cloning the repository or writing configuration by hand.

## Requirements

### Requirement: Install with one piped command
The system SHALL provide an installer script that runs correctly when fetched over HTTPS and piped to `sh` (`curl -fsSL <url> | sh`), and when saved and run directly. It SHALL run under a POSIX `sh`, SHALL need no tool beyond `curl`, Docker with Compose v2, and a secure random source, and SHALL do nothing at all if the download is cut short.

#### Scenario: Piped run
- **WHEN** an operator runs the documented command in a terminal
- **THEN** the installer starts and asks its questions in that terminal, although its standard input is the script

#### Scenario: Truncated download
- **WHEN** the script text is cut off part-way
- **THEN** no command in it runs, no file is written and nothing is started

### Requirement: Check prerequisites before changing anything
The installer SHALL check that the operating system is Linux, macOS or WSL, that Docker and Docker Compose v2 are installed, that the Docker daemon answers, and that the chosen port is free, before it writes any file or starts any container. A failed check SHALL stop the installer with a message that names what is missing and how to fix it.

#### Scenario: Docker is not running
- **WHEN** Docker is installed but its daemon is stopped
- **THEN** the installer stops, says the daemon is not reachable, and has written nothing

#### Scenario: Port in use
- **WHEN** the chosen port is already bound on the machine
- **THEN** the installer reports the port as busy and asks for another one, or stops when it cannot ask

### Requirement: Ask only what it cannot decide
In a terminal, the installer SHALL ask for the install folder, the port, the first administrator's email and the administrator's password, each with a shown default where one exists, and SHALL show a summary of the answers and the files it will write and ask for confirmation before writing. An invalid answer SHALL be explained and asked again. The password SHALL be typed without echo and SHALL be at least 12 characters, or the installer SHALL generate one and show it once at the end.

#### Scenario: Accept the defaults
- **WHEN** an operator presses Enter at the folder and port questions and answers the rest
- **THEN** the installation goes to `./docmyrepos` on port 3000

#### Scenario: Weak password
- **WHEN** an operator types a password shorter than 12 characters
- **THEN** it is refused with the reason and asked again

#### Scenario: Declined at the summary
- **WHEN** the operator answers no at the confirmation
- **THEN** nothing is written or started and the installer exits without error

### Requirement: Generated secrets are strong and private
The installer SHALL generate the settings encryption key, the session secret, the sync secret and the database password from a cryptographically secure source, SHALL never use a placeholder or default value for them, SHALL write them only to the installation's `.env` file with owner-only permissions, and SHALL never print them or pass them as command arguments. The only secret it may print is a password it generated for the administrator, once, at the end.

#### Scenario: Permissions of the written files
- **WHEN** the installer finishes
- **THEN** the `.env` file is readable and writable by its owner only, and none of the generated secrets appears in the terminal output

#### Scenario: Two installs differ
- **WHEN** the installer is run twice into different folders
- **THEN** every generated secret differs between them

### Requirement: Never overwrite an installation
The installer SHALL stop, without changing any file, when the chosen folder already contains an `.env` or `docker-compose.yml`, and SHALL write each file completely or not at all.

#### Scenario: Existing installation
- **WHEN** the chosen folder already holds a `docker-compose.yml`
- **THEN** the installer stops, says so, and leaves the existing files untouched

#### Scenario: Failure while writing
- **WHEN** the installer fails after writing one of its files and before the other
- **THEN** the partial files it created are removed

### Requirement: Start and verify the installation
After writing, the installer SHALL pull the container image (unless that image is already on the machine), start the app and its database, and wait until the app's health check reports ready. On success it SHALL print the address, the administrator's email, and the next steps: sign in, open the workspace configuration page, enter the GitHub App, and run the first sync. On failure it SHALL name the failing step and print the last lines of the app's log and the command to see more.

#### Scenario: Success
- **WHEN** the containers start and the health check passes
- **THEN** the output shows the portal address, the admin email, and the steps from sign-in to the first sync

#### Scenario: App does not become healthy
- **WHEN** the health check does not pass within the time limit
- **THEN** the installer exits with an error, prints the failing step and the end of the app log, and leaves the files in place

### Requirement: Scriptable and previewable
The installer SHALL accept every answer as a flag or `DOCMYREPOS_*` environment variable, SHALL read the administrator password only from the environment, SHALL run without prompts when `--yes` is given or no terminal is available, and SHALL list every missing answer at once and exit with a non-zero status when a required answer is missing. `--dry-run` SHALL show the checks' results, the answers and the files that would be written, and SHALL write and start nothing.

#### Scenario: No terminal, all answers given
- **WHEN** the installer runs with no terminal and every answer supplied
- **THEN** it installs without asking anything

#### Scenario: No terminal, answers missing
- **WHEN** the installer runs with no terminal and the admin email is missing
- **THEN** it lists the missing answer, writes nothing and exits non-zero

#### Scenario: Dry run
- **WHEN** the installer runs with `--dry-run`
- **THEN** it prints the plan and the target files and creates no file or container

### Requirement: Safe handling of input and network
The installer SHALL validate every answer before using it (a port number in range, a plausible email, a folder path with no control characters) and SHALL never evaluate an answer as shell code. It SHALL contact only the registry that hosts the image and the app on the loopback address, SHALL fetch nothing over plain HTTP, and SHALL send no telemetry.

#### Scenario: Hostile answer
- **WHEN** the folder or email answer contains shell metacharacters or a newline
- **THEN** it is rejected or used literally, and no command embedded in it runs

#### Scenario: Network use
- **WHEN** the installer runs
- **THEN** its only network traffic is the image pull and requests to the loopback address

### Requirement: Installed compose file keeps the hardening
The compose file the installer writes SHALL carry the same hardening as the repository's compose file (read-only root file system, temporary file system for `/tmp`, all capabilities dropped, no new privileges, a process limit, rotated logs, an init process), SHALL publish the app only on the loopback address by default, and SHALL NOT publish the database port.

#### Scenario: Compare with the repository file
- **WHEN** the written compose file is compared with the repository's `docker-compose.yml`
- **THEN** every hardening setting present in the repository file is present with the same value, and the database has no published port

### Requirement: Installer is covered by automated tests
The repository SHALL test the installer without Docker in unit tests (checks, validation, generated secrets, file contents and permissions, refusal to overwrite, dry run, non-interactive failure) and with Docker in CI (a full install against the image built in the run, with its health check, login page and a rejected second install).

#### Scenario: Pull request changes the installer
- **WHEN** a pull request changes the installer, the compose file, the Dockerfile or the environment contract
- **THEN** the installer tests run and a failure blocks the merge

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
