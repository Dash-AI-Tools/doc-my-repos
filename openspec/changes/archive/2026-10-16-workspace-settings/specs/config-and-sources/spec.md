# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Config file narrows the repositories shown`
- TO: `### Requirement: Settings narrow the repositories shown`

## MODIFIED Requirements

### Requirement: Settings narrow the repositories shown
The system SHALL read, from the workspace settings an administrator manages, an optional narrowing of the repositories the GitHub App installation can access, using either an explicit list of repositories or an exclusion list. When neither is set, every repository the installation can access SHALL be synced and shown.

#### Scenario: Default is every accessible repository
- **WHEN** the settings declare neither a repository list nor exclusions
- **THEN** every non-archived repository the GitHub App installation can access is synced and shown

#### Scenario: Explicit repository list
- **WHEN** the settings list repositories `api-service` and `web-app`
- **THEN** only those two repositories are synced and shown, provided the installation can access them

#### Scenario: Exclusions
- **WHEN** the settings exclude `sandbox`
- **THEN** every accessible repository except `sandbox` is synced; archived repositories are skipped

#### Scenario: Listed repository not accessible
- **WHEN** the settings list a repository that the installation cannot access
- **THEN** the next sync reports "not accessible by the GitHub App" for it, and the other repositories are unaffected

### Requirement: Configuration validation
The system SHALL validate the workspace settings when an administrator saves them and refuse an invalid save with a message naming each invalid field, SHALL validate the environment variables that remain (database URL, session secret, sync secret, encryption key) at startup and fail with a message naming each invalid or missing item, and SHALL NOT read GitHub App credentials, the webhook secret, provider credentials or a config file from the environment or disk.

#### Scenario: Missing App credential
- **WHEN** the GitHub App id, private key or installation id has not been saved
- **THEN** the admin page and status page name the missing setting, sync and webhooks report "not configured", and no secret value is printed

#### Scenario: Missing environment variable
- **WHEN** the database URL, session secret, sync secret or encryption key is not set or invalid
- **THEN** startup fails with an error that names the variable and does not print any secret value

#### Scenario: Weak shared secret
- **WHEN** the sync secret is shorter than 16 characters after trimming whitespace, or the webhook secret saved by an administrator is
- **THEN** startup or the save fails with an error that names the variable or field and does not print the value

#### Scenario: Unreadable private key
- **WHEN** an administrator saves a private key that is not a valid PEM key
- **THEN** the save is refused with an error that identifies the field and never echoes the key

#### Scenario: Invalid config
- **WHEN** an administrator saves a field of the wrong type or an unknown field
- **THEN** the save is refused with an error that identifies the field

#### Scenario: Conflicting narrowing
- **WHEN** an administrator saves both a repository list and an exclusion list
- **THEN** the save is refused with an error that identifies the `exclude` field and says only one of `repos` or `exclude` may be set

#### Scenario: Empty list
- **WHEN** an administrator saves `repos` or `exclude` as an empty list
- **THEN** the save is refused with an error that identifies the field, so an empty list is never read as "show nothing" or "no narrowing"

#### Scenario: Config file location
- **WHEN** a `docmyrepos.config.yml`, `CONFIG_PATH` or a retired `GITHUB_APP_*` variable is present
- **THEN** it is not read, and the status page and startup log say once that the values must be entered in the admin settings

#### Scenario: No config file
- **WHEN** no repository narrowing has been saved
- **THEN** the system behaves as if neither a repository list nor exclusions were set, so every accessible repository is shown once GitHub is configured
