## Purpose

Lets an organization install a working DocMyRepos with one command and a few answers, by checking the machine, collecting and validating the required settings, generating the secrets, writing a complete installation and starting it.

## ADDED Requirements

### Requirement: Run with one command
The system SHALL provide an installer started with `npx create-docmyrepos` (equally `npm create docmyrepos` and `pnpm create docmyrepos`) that needs no prior checkout, account or configuration, and SHALL accept an optional target folder (default `./docmyrepos`). It SHALL run on macOS, Linux and Windows with Node.js 20 or newer, and SHALL report an unsupported Node version before doing anything else.

#### Scenario: Fresh machine
- **WHEN** a user with Node 20, Docker and Compose runs the command in an empty directory
- **THEN** the wizard starts and asks its questions without any prior setup

#### Scenario: Old Node
- **WHEN** the command is run with a Node version below 20
- **THEN** the wizard prints the required version and exits non-zero without creating any file

### Requirement: Check prerequisites first
The system SHALL, before asking anything that costs effort or writing anything, check that Docker and Docker Compose v2 are installed and the Docker daemon is reachable, that the target folder is usable, and that the chosen host port is free. Each failure SHALL be reported with the check that failed and how to fix it, and SHALL stop the wizard with a non-zero exit and no files written.

#### Scenario: Docker not running
- **WHEN** Docker is installed but the daemon is not running
- **THEN** the wizard says so, suggests starting Docker, and exits without writing files

#### Scenario: Port in use
- **WHEN** port 3000 is already taken
- **THEN** the wizard reports it and offers another port

#### Scenario: Compose missing
- **WHEN** `docker compose` is not available
- **THEN** the wizard names the missing component and links the install instructions

### Requirement: Ask only for what is needed
The system SHALL ask for the GitHub organization, the address the portal will be reached at (default `http://localhost:3000`), the host port, the first administrator's email and password, and which repositories to include (all the App can access, or a chosen list). Every other setting SHALL take a safe default. It SHALL show each default, SHALL let the user accept it with Enter, and SHALL NOT ask for anything it can generate or discover.

#### Scenario: Defaults accepted
- **WHEN** the user presses Enter at each question that has a default
- **THEN** the installation is configured with those defaults

#### Scenario: Secrets not asked
- **WHEN** the wizard reaches secret settings (session, sync, database, webhook)
- **THEN** it generates them and does not prompt for them

### Requirement: Validate every answer
The system SHALL validate each answer as it is given with the same rules the app enforces at startup (organization login, URL scheme and host, port range, email, a password of at least 12 characters), SHALL explain a rejection in plain words and ask again, and SHALL mask the password while it is typed and ask for it twice. For an address that is not `localhost` or a loopback address it SHALL require `https` and warn that the portal needs TLS in front of it.

#### Scenario: Invalid email
- **WHEN** the user enters `admin@` as the admin email
- **THEN** the wizard explains the problem and asks again without continuing

#### Scenario: Short password
- **WHEN** the user enters a password shorter than 12 characters
- **THEN** it is rejected with the reason, and the user may let the wizard generate a strong one

#### Scenario: Password hidden
- **WHEN** the user types the password
- **THEN** nothing typed appears on screen or in terminal history

#### Scenario: Plain http on the internet
- **WHEN** the user enters `http://docs.example.com`
- **THEN** the wizard rejects it and explains that a public address needs https

### Requirement: Generate strong secrets
The system SHALL generate the session secret, the sync secret and the database password from a cryptographically secure source with at least 256 bits each, SHALL NOT reuse the placeholder values of the example environment file or the default database credentials, and SHALL generate the admin password the same way when the user asks for one, showing it once on screen and never writing it anywhere except the environment file.

#### Scenario: Unique secrets
- **WHEN** the wizard is run twice
- **THEN** every generated secret differs between the two runs

#### Scenario: No placeholders
- **WHEN** the written environment file is checked
- **THEN** it contains no `replace-with-` placeholder and no default database password

### Requirement: Write a complete installation
The system SHALL write into the target folder a `docker-compose.yml` that runs the published image with Postgres and the same hardening as the repository's compose file, an `.env` with every required setting, a `docmyrepos.config.yml` reflecting the repository choice, and the GitHub App private key. Files holding secrets SHALL be created readable by the owner only. The compose file SHALL pin the image version matching the installer. The files SHALL pass the app's own validation when started.

#### Scenario: Files present
- **WHEN** the wizard finishes writing
- **THEN** the folder contains the compose file, `.env`, the config file and the key file, each with owner-only permissions where they hold secrets

#### Scenario: App accepts the settings
- **WHEN** the generated files are used to start the app
- **THEN** it starts without configuration errors

#### Scenario: Hardening kept
- **WHEN** the generated compose file is compared with the repository's
- **THEN** the read-only file system, dropped capabilities, no-new-privileges, loopback binding and log rotation are all present

### Requirement: Never overwrite an installation
The system SHALL refuse to write into a folder that already contains an installation (an `.env` or a `docker-compose.yml`), saying so and exiting non-zero without changing anything. With an explicit `--force` it SHALL first move the existing files to timestamped backups with the same permissions. It SHALL write files atomically so that an interrupted run leaves no half-written secret file.

#### Scenario: Existing install
- **WHEN** the target folder has an `.env`
- **THEN** the wizard stops with a message and no file is changed

#### Scenario: Forced
- **WHEN** the user passes `--force`
- **THEN** existing files are backed up with a timestamp before new ones are written

#### Scenario: Interrupted
- **WHEN** the wizard is interrupted with Ctrl+C
- **THEN** it leaves no partly written `.env` or key file and tells the user whether anything was written

### Requirement: Start and verify
The system SHALL, unless told not to, pull the image, start the app and database, wait up to a bounded time for the health check to pass, start the first sync, and then print the address, the administrator email, whether the first sync started, and the next steps. A failure at any step SHALL be reported with the failing step and the command to see the logs, SHALL leave the written files in place, and SHALL exit non-zero.

#### Scenario: Healthy start
- **WHEN** the containers become healthy
- **THEN** the wizard prints the address, the sign-in email and where to follow the first sync

#### Scenario: Startup fails
- **WHEN** the app does not become healthy within the time limit
- **THEN** the wizard shows the last log lines, the command to read more, keeps the files, and exits non-zero

#### Scenario: Start skipped
- **WHEN** the user passes `--no-start`
- **THEN** the files are written and the wizard prints the command to start them

### Requirement: Non-interactive mode
The system SHALL support running without prompts when `--yes` is given with every answer supplied by flags or environment variables, SHALL fail with a list of the missing answers instead of prompting when input is not a terminal, and SHALL accept secrets (admin password, existing App key) from environment variables or files, not from command-line arguments.

#### Scenario: Scripted install
- **WHEN** all answers are supplied with `--yes` and the environment
- **THEN** the installation completes with no prompt

#### Scenario: Missing answers
- **WHEN** `--yes` is given without the organization
- **THEN** the wizard names the missing answer and exits non-zero without prompting

#### Scenario: No secrets in arguments
- **WHEN** the command line is inspected
- **THEN** no option takes a secret value directly

### Requirement: Dry run
The system SHALL, with `--dry-run`, run the checks and questions, print every file it would write and every command it would run with secret values hidden, and write nothing, create no GitHub App, and start nothing.

#### Scenario: Plan only
- **WHEN** the user passes `--dry-run`
- **THEN** the plan is printed, the folder is unchanged, and no request that creates anything is sent

### Requirement: Safety and privacy
The system SHALL send network requests only to GitHub (`github.com`, `api.github.com`) and, for pulling the image, the container registry through Docker. It SHALL NOT collect or send telemetry, SHALL NOT print or log secret values (apart from the generated admin password shown once on request), SHALL NOT pass secrets in process arguments, SHALL start external programs without a shell, and SHALL print a fixed summary of what it is about to write before writing it.

#### Scenario: No telemetry
- **WHEN** the wizard runs
- **THEN** no request goes to any host other than GitHub

#### Scenario: Secrets hidden
- **WHEN** the output and error text of a full run are inspected
- **THEN** no secret value appears in them

#### Scenario: Confirmation before writing
- **WHEN** all answers are collected
- **THEN** the wizard lists the files it will write and asks to continue (unless `--yes`)

### Requirement: Remove the bootstrap credentials
The system SHALL offer, after the first sign-in, to remove the administrator email and password from the environment file and restart the app, and SHALL print how to do it by hand when declined.

#### Scenario: Cleanup accepted
- **WHEN** the user confirms they have signed in and accepts the cleanup
- **THEN** the credentials are removed from `.env` and the app is restarted

#### Scenario: Cleanup declined
- **WHEN** the user declines
- **THEN** the wizard prints the two lines to remove and the restart command
